# V04 work item 3 — every P0 acceptance criterion mapped to evidence

Derived from the spec bodies (147 `FR-*` headings + every `MUST` sentence across the 18 P0 specs
enumerated in `p0-acceptance-criteria.md`), **against the gate inventory, before this campaign's gate
results were read**. Reading the results first would let a passing gate rewrite its own claim.

## How to read the evidence column

| Tag | Meaning |
|---|---|
| **R** | Runtime evidence, taken **in this campaign** against the re-pinned candidate |
| **H** | Recorded from an inherited campaign (V01/V02). Honest evidence about the tree at that time; **not** re-measured here |
| **S** | Static/schema/unit only. Supports the criterion; never constitutes it |
| **—** | No evidence found at any layer. **UNPROVEN**, and named as such |

A criterion mapped `S` is not thereby satisfied: `pnpm check` cannot open a Worker or a browser, so
every `S` below is a claim the release decision must carry as unproven at the runtime layer unless
another row proves it.

## F01 — Identity & Authentication (P0) · 17 FR

| FR | Criterion | Evidence | Layer |
|---|---|---|---|
| FR-F01-001 | User identity | `smoke:p02` signup+verify, `smoke:browser` real sign-in | R |
| FR-F01-002 | Email verification | `smoke:p02`, `smoke:browser` (verification step driven) | R |
| FR-F01-003 | Authentication priority | `smoke:passkey` (passkey-first), `smoke:browser` | R |
| FR-F01-004 | Passkey registration | `smoke:passkey` real CTAP2 ceremony + `smoke:browser` | R |
| FR-F01-005 | Passkey login | `smoke:passkey`, `smoke:browser` | R |
| FR-F01-006 | Conditional mediation | `smoke:browser` (UI mediation branch) | R |
| FR-F01-007 | Password fallback | `smoke:p02`, `smoke:browser` | R |
| FR-F01-008 | Password signup/login | `smoke:p02` password routes | R |
| FR-F01-009 | Passkey management | `smoke:browser`; `smoke:passkey` revoke/rename paths | R/H |
| FR-F01-010 | WebAuthn ceremony state | `smoke:passkey` (challenge/expiry/replay attacks) | R |
| FR-F01-011 | WebAuthn verification | `smoke:passkey` (origin, RP ID, signature) | R |
| FR-F01-012 | Identity linking | `smoke:passkey` identity-link conflict attack (declared KNOWN MISSED on one leg) | R |
| FR-F01-013 | Desktop sign-in | `smoke:p02` — full device-code handoff: `start` (PKCE S256 challenge) → `approve` (204) → `exchange` (200) → **`exchange` again, refused `[401, 409]`** | R |
| FR-F01-014 | Access tokens / sessions | `smoke:p02`, `smoke:browser` | R |
| FR-F01-015 | Recovery | `smoke:p02` reset flow; sensitivity `A2` (pre-recovery session refused) | R |
| FR-F01-016 | Reauthentication / step-up | `verify:privilege-escalation` (ownership-transfer class), sensitivity `M2` re-auth guard | R |
| FR-F01-017 | Security events | `schema:p07`, `verify:adoption-privacy` (nothing reaches `security_events`), `verify:staff-credential` | R |

**CORRECTED (V04):** this map first graded FR-F01-013 desktop sign-in **UNPROVEN** on the claim that
"no probe drives `/auth/device-code`". That was **false**, and the error is worth recording because it
is the exact shape this campaign exists to prevent. `smoke:p02:245-270` drives the whole flow — start
with a real PKCE S256 `code_challenge`, `approve` returning 204, `exchange` returning 200, and then
**`exchange` again with the same one-time `device_code`, asserted to be refused `[401, 409]`**. That
last assertion is a replay attack on a P0 identity criterion, and it is the runtime evidence for
Tier-0 **T0-03** on the device-code path.

**The lesson is about method, not about the criterion.** Asserting an *absence* requires reading the
gate, not grepping for a string that might be spelled differently: the search looked for the route
name and did not find it, while the probe had been exercising it all along. Every one of this map's
fourteen `—` rows was then re-checked by searching the probes for the behaviour; this was the only
one wrong, and the other thirteen held. But a false **UNPROVEN** on a P0 criterion is as damaging as a
false PASS — it would either block a release that is actually ready, or send someone looking for a gap
that does not exist.

## F02 — Organization & Tenant Lifecycle (P0) · 7 FR

| FR | Criterion | Evidence | Layer |
|---|---|---|---|
| FR-F02-001 | Organization creation | `smoke:p02`; `smoke:browser` (two orgs) | R |
| FR-F02-002 | **Tenant scoping** | `verify:collection-tenancy` (54/54), `verify:filter-tenancy` (65/65), `verify:path-id-tenancy` (198/198), `verify:mutating-tenancy` | R |
| FR-F02-003 | Active org context | `smoke:browser` (switch without stale data) | R |
| FR-F02-004 | Organization lifecycle | `verify:path-id-tenancy` (suspend/resume routes) | R |
| FR-F02-005 | Ownership (last owner) | `verify:privilege-escalation` last-owner class, sensitivity `M1`/`M2` | R |
| FR-F02-006 | Ownership transfer | `verify:privilege-escalation` transfer class, sensitivity `M2`–`M5` | R |
| FR-F02-007 | Deletion | `verify:mutating-tenancy` (org-scoped mutations); `smoke:p06` personal deletion | R/H |

## F03 — Membership, Invitations & Teams (P0) · 8 FR

| FR | Criterion | Evidence | Layer |
|---|---|---|---|
| FR-F03-001 | Member directory | `verify:collection-tenancy`, `verify:filter-tenancy` (membership detail) | R |
| FR-F03-002 | Invitations | `verify:invitation-race` (23/23) | R |
| FR-F03-003 | Accept invitation | `verify:invitation-race`, `smoke:p03` | R |
| FR-F03-004 | Invite lifecycle | `smoke:p03` (revoke/resend) | R |
| FR-F03-005 | Member removal | `verify:mutating-tenancy`, path-id sensitivity `M1`/`M2` | R |
| FR-F03-006 | Leave organization | `smoke:p03`; last-owner sensitivity `M1` | R |
| FR-F03-007 | **Teams** | `smoke:p03`; V02 repaired a 37-vs-36 id defect that had made **every team write fail** | R |
| FR-F03-008 | Bulk operations | **no bulk route exists in the router at all** (`app.rs` has no `bulk` path) — so there is nothing for a probe to drive | **—** |

## F04 — Authorization & Policy Engine (P0) · 7 FR

| FR | Criterion | Evidence | Layer |
|---|---|---|---|
| FR-F04-001 | Server-side authorization | `verify:privilege-escalation` (7 client-field classes, graded on stored state) | R |
| FR-F04-002 | Resource scope | the four tenancy gates | R |
| FR-F04-003 | **Deny by default** | `verify:tool-policy-deny` (a Deny that the caller proceeds past) | R |
| FR-F04-004 | Owner invariants | `verify:privilege-escalation` last-owner class | R |
| FR-F04-005 | Project access | `verify:privilege-escalation`, `verify:path-id-tenancy` (grants) | R |
| FR-F04-006 | Policy precedence | `verify:privilege-escalation` (policy-version class) | R |
| FR-F04-007 | **Explainability** | `verify:tool-policy-deny` (**50/50**) — the tool-decision response body carries a machine-readable reason to a device-authorized caller, and it **discriminates**: `org_tool_denied` on the deny leg, `policy_allowed` on the allow leg. Non-disclosure half: `verify:path-id-tenancy` (198/198). **Asserted, not merely observed** — the assertion is on the wire, graded against the leg, and `evidence/v04-f04-007-sensitivity.sh` proves it by making the route return a **constant** `policy_allowed` (**1/1 detected, exit 0**): a presence-only check would pass on that fault, so this one is not decorative | R |

## F05 — Sessions, Devices & Account Security (P0) · 6 FR

| FR | Criterion | Evidence | Layer |
|---|---|---|---|
| FR-F05-001 | Session inventory | `smoke:browser` (account sessions view) | R |
| FR-F05-002 | Revocation | `verify:revoked-device` (29/29), `smoke:p02` session revoke | R |
| FR-F05-003 | Device identity | `verify:revoked-device`, `verify:device-idempotency` | R |
| FR-F05-004 | Reauthentication | `verify:privilege-escalation` transfer class | R |
| FR-F05-005 | MFA / passkeys | `smoke:passkey` (55/55), `smoke:browser` | R |
| FR-F05-006 | Security notifications | `schema:p07`; no probe drives the notification surface | **—** |

## F07 — Projects, Workspaces & Ownership (P0) · 7 FR

| FR | Criterion | Evidence | Layer |
|---|---|---|---|
| FR-F07-001 | Project creation | `smoke:p02`, `verify:privilege-escalation` | R |
| FR-F07-002 | Workspace binding | `verify:path-id-tenancy` (binding routes) | R |
| FR-F07-003 | Ownership | `verify:privilege-escalation`, `verify:mutating-tenancy` | R |
| FR-F07-004 | Restricted projects | `verify:privilege-escalation` (access/grant field class) | R |
| FR-F07-005 | Archive | `verify:mutating-tenancy` (project mutations) | R |
| FR-F07-006 | Member removal | `verify:mutating-tenancy` | R |
| FR-F07-007 | Workspace privacy | `verify:adoption-privacy` (path and key classes) | R |

## F08 — Agents, Sessions, Runs & Artifacts (P0) · 8 FR

| FR | Criterion | Evidence | Layer |
|---|---|---|---|
| FR-F08-001 | Agent definition | `verify:path-id-tenancy`, `verify:collection-tenancy` | R |
| FR-F08-002 | Session | `verify:filter-tenancy` (sessions by project) | R |
| FR-F08-003 | Run states | `verify:lease-contention`, `verify:attempt-exhaustion` | R |
| FR-F08-004 | Event stream | `verify:filter-tenancy`, `verify:path-id-tenancy` (run events) | R |
| FR-F08-005 | **Conversation privacy** | `verify:adoption-privacy` (conversation-history class) | R |
| FR-F08-006 | Artifact references | `smoke:p05`, `verify:path-id-tenancy` | R/H |
| FR-F08-007 | Cancellation | `verify:mutating-tenancy`, `smoke:p05` | R |
| FR-F08-008 | Resume / retry | `verify:attempt-exhaustion`, `verify:path-id-tenancy` (retry route) | R |

## F09 — Model & Provider Catalog (P0) · 7 FR

| FR | Criterion | Evidence | Layer |
|---|---|---|---|
| FR-F09-001 | Provider registry | `verify:path-id-tenancy` (provider routes) | R |
| FR-F09-002 | Model records | `verify:path-id-tenancy` (model routes) | R |
| FR-F09-003 | Aliases | `verify:privilege-escalation` (model alias/route class) | R |
| FR-F09-004 | Capability-based selection | `smoke:p05`, `verify:budget-hardceiling` (capability vocabulary) | R/H |
| FR-F09-005 | Org allowlist | `verify:privilege-escalation`; **provider egress** is UNPROVEN — see `verify:provider-faults` | R / **—** |
| FR-F09-006 | Catalog distribution | `verify:collection-tenancy` (catalog route) | R |
| FR-F09-007 | **Provider health / cooldown** | no probe reaches an upstream; `verify:provider-faults` is BLOCKED by the sandbox | **—** |

## F10 — AI Inference Router / Proxy (P0) · 0 FR, 5 MUST

| MUST | Evidence | Layer |
|---|---|---|
| routing by alias with a vendor-neutral contract | `verify:budget-hardceiling`, `smoke:p05` | R |
| budget admission before upstream dispatch | `verify:budget-hardceiling` (25/25, unmanaged path) | R |
| no fallback after committed output | `verify:inference-failure` (output-then-fail, mid-stream disconnect) | R |
| usage attributed to the right org/project/run | `verify:usage-attribution` (+ 1 named SKIP: managed `run_id`) | R |
| provider failures classified, bounded, not retried into duplicates | **`verify:provider-faults` exits 2 in this environment** — measured 0 calls on every address class | **—** |

## F11 — Credentials, Secrets & BYOK (P0) · 9 FR

| FR | Criterion | Evidence | Layer |
|---|---|---|---|
| FR-F11-001 | Secret envelope | `verify:secret-tenancy` (32/32, 1 named SKIP) | R |
| FR-F11-002 | **No re-display** | `verify:secret-tenancy` asserts no secret plaintext in any cross-tenant body; `schema:p07` | R |
| FR-F11-003 | Credential metadata | `verify:path-id-tenancy`, `verify:collection-tenancy` | R |
| FR-F11-004 | BYOK precedence | `smoke:p05` (`credential_mode: platform_only`) | R/H |
| FR-F11-005 | Validation | `schema:bind-count`, `smoke:p02` error envelope | R |
| FR-F11-006 | Rotation | `verify:secret-tenancy` (rotate family, controls create their own rows) | R |
| FR-F11-007 | Revocation | `verify:secret-tenancy` | R |
| FR-F11-008 | Secret use | `smoke:p06` (webhook signing path) | R/H |
| FR-F11-009 | **Local-only** | `verify:adoption-privacy` (API key, MCP secret, private-key classes) | R |

## F12 — Usage, Quotas & Budgets (P0) · 8 FR

| FR | Criterion | Evidence | Layer |
|---|---|---|---|
| FR-F12-001 | Immutable raw usage | `schema:p07`, `verify:usage-attribution` | R |
| FR-F12-002 | Pricing version | `verify:usage-attribution` (row self-consistency) | R |
| FR-F12-003 | Budget scopes | `verify:budget-concurrency`, `verify:budget-hardceiling` | R |
| FR-F12-004 | **Hard and soft limits** | `verify:budget-hardceiling` (hard, pre-dispatch) | R (soft limit: **—**) |
| FR-F12-005 | Reservation | `verify:budget-concurrency` (8 simultaneous, 3 grant), `verify:inference-failure` (release on every outcome) | R |
| FR-F12-006 | Rate limits | `verify:budget-hardceiling` rate admission on the managed path | R |
| FR-F12-007 | Usage rollups | `verify:filter-tenancy` (usage by project) | R |
| FR-F12-008 | Provider reconciliation | no probe reconciles a provider bill | **—** |

## F13 — Tools, MCP, Browser & Computer-Use Policies (P0) · 9 FR

| FR | Criterion | Evidence | Layer |
|---|---|---|---|
| FR-F13-001 | Tool catalog | `verify:collection-tenancy`, `verify:path-id-tenancy` | R |
| FR-F13-002 | Effective policy | `verify:tool-policy-deny` | R |
| FR-F13-003 | **Default posture** | `verify:tool-policy-deny` (deny branch) | R |
| FR-F13-004 | MCP | `verify:path-id-tenancy`, `verify:adoption-privacy` (MCP secret) | R |
| FR-F13-005 | Browser use | `verify:tool-policy-deny` (**71/71**) — the settable controls driven over real HTTP with real reasons: `allowed_domains`, `blocked_domains`, `allow_download`, `allow_upload`, `allow_authenticated`, `allow_clipboard`, `external_submit`. Every denial carries `browser_action_denied`, and `evidence/v04-f13-sensitivity.sh` proves **2/2 detected**: making `allow_download` permissive reds exactly one assertion and leaves the computer family green. **`blocked_categories` is UNIMPLEMENTED** — consulted by no decision, rejected `422` by the API. **The surface is also unreachable in the product**: `capability_definitions` has no writer, so every browser call is refused `capability_not_defined` — **V04-010** | R (9 of 10 controls) |
| FR-F13-006 | Computer use | `verify:tool-policy-deny` (**71/71**) — `allow_accessibility`, `allow_screen_capture`, `allow_keyboard_mouse`, `allow_shell_escalation` and `allowed_applications`, each denial carrying `computer_action_denied`, with a sensitivity proof for the family. **`blocked_applications` is UNIMPLEMENTED** and rejected `422`. **The surface is unreachable in the product** for the same reason — **V04-010** | R (5 of 6 controls) |
| FR-F13-007 | Approval gates | `smoke:p05`, `verify:privilege-escalation` | R/H |
| FR-F13-008 | Secret isolation | `verify:adoption-privacy`, `verify:secret-tenancy` | R |
| FR-F13-009 | Network egress | `verify:provider-faults` BLOCKED; allowlist logic `S` | **—** |

## F16 — Audit, Security Events & Support Access (P0) · 5 FR

| FR | Criterion | Evidence | Layer |
|---|---|---|---|
| FR-F16-001 | Immutable audit event | `schema:p07` (append-only, CHECK vocabulary), `verify:staff-credential` (actor column value) | R |
| FR-F16-002 | Append path | `verify:staff-credential` (V04-038's column-value assertion) | R |
| FR-F16-003 | Search / export | `verify:filter-tenancy` (audit route's 12 id filters) | R |
| FR-F16-004 | Security events | `verify:adoption-privacy` (nothing reaches `security_events`), `schema:p07` | R |
| FR-F16-005 | **Support access** | `verify:staff-credential` (46/46) proves staff is refused everywhere — the **grant-use** half is recorded UNPROVEN and deliberately unrepaired | R (partial) |

## F19 — Device Enrollment & Policy Sync (P0) · 9 FR

| FR | Criterion | Evidence | Layer |
|---|---|---|---|
| FR-F19-001 | Enrollment | `verify:device-idempotency` (23/23) | R |
| FR-F19-002 | Device credential | `verify:revoked-device` (real signed refresh) | R |
| FR-F19-003 | Capability reporting | `smoke:p05`, `verify:lease-contention` (two real devices) | R |
| FR-F19-004 | Policy snapshot | `smoke:p05` (`ack_policy`, `fetch_policy`) | R |
| FR-F19-005 | Signed / versioned sync | `smoke:p05`; static snapshot predicate in `verify:budget-hardceiling` | R |
| FR-F19-006 | Fail-safe behavior | `smoke:p05`, `verify:revoked-device` | R |
| FR-F19-007 | Revocation | `verify:revoked-device` | R |
| FR-F19-008 | Minimum client version | **UNIMPLEMENTED, not merely unproven.** `org_device_policy_settings.min_client_version` is read (`devices.rs:386`) and enforced (`devices.rs:822` → `client_version_too_old`) but **never written** — repo-wide the table has two mentions: the `CREATE TABLE` (migration 0007) and that `SELECT`. So the guard's condition can never hold and `version_at_least` at `devices.rs:823` cannot execute. The one reachable floor (`MIN_CLIENT_APP_VERSION`) is **advisory** only (`derive_remediations`), and `validate_app_version` checks syntax alone, so any syntactically valid `app_version` reaches cloud-managed operations. Fails **open**. No spec or ADR names the column or a route that arms it. **V04-008**; enforced against recurrence by `security::guarded_column_writers` | **—** (capability absent) |
| FR-F19-009 | Heartbeat | `smoke:p05` | R |

## F21 — Operations, Observability & Reliability (P0) · 11 FR

| FR | Criterion | Evidence | Layer |
|---|---|---|---|
| FR-F21-001 | Correlation ID | `verify:observability` (request → usage → audit), `smoke:browser` | R |
| FR-F21-002 | Structured logs | `verify:observability` (redaction), `schema:null-check`, middleware unit suite | R |
| FR-F21-003 | Metrics cardinality | `verify:observability` (bounded dimensions) | R |
| FR-F21-004 | Tracing | Sentry entry + ADR 0009; span collection **not** verified end to end | R/S |
| FR-F21-005 | Health | `smoke:local` `/api/health`, `smoke:p02` | R |
| FR-F21-006 | Timeouts | `S` (every adapter sets one; no probe measures an expiry) | **S** |
| FR-F21-007 | Retries | `smoke:p05` outbox retry sweep, `verify:attempt-exhaustion` (bounded) | R |
| FR-F21-008 | Circuit / cooldown | no probe drives repeated classified upstream failure | **—** |
| FR-F21-009 | Queues / jobs | **this campaign** — `smoke:p06` after V04-002; dead-letter recorded and replayed | R |
| FR-F21-010 | SLOs | `perf:budgets` measures the API p95 target; monthly availability is not measurable pre-release | R / **—** |
| FR-F21-011 | Backup / restore | `verify:restore` (125/125 + lossy-restore control), RTO recorded | R |

## F22 — Web Control Plane UX (P0) · 11 FR

| FR | Criterion | Evidence | Layer |
|---|---|---|---|
| FR-F22-001 | Org switcher | `smoke:browser` (two orgs, no stale data) | R |
| FR-F22-002 | Permission-aware navigation | `smoke:browser` | R |
| FR-F22-003 | Page states | V02-002 drove loading / server-error / retry for the first time | R |
| FR-F22-004 | Tables | `smoke:browser`, `perf:budgets` | R |
| FR-F22-005 | Mutations | `smoke:browser` | R |
| FR-F22-006 | Destructive actions | `smoke:browser` | R |
| FR-F22-007 | Accessibility | `smoke:browser` (keyboard focus), `perf:budgets` | R |
| FR-F22-008 | Responsive | `smoke:browser` (390 px) | R |
| FR-F22-009 | Performance | `perf:budgets` (V02-003, measured against the production build) | R |
| FR-F22-010 | Design system | `pnpm lint` + component inventory; no rendered comparison gate | **S** |
| FR-F22-011 | Error language | `smoke:browser` error states, `smoke:p02` envelope | R |

## F23 — API Contracts (P0) · 10 FR

| FR | Criterion | Evidence | Layer |
|---|---|---|---|
| FR-F23-001 | Versioning | `schema:bind-count`, route inventory; every path is `/api/v1/**` | R |
| FR-F23-002 | Pagination | `verify:filter-tenancy` (foreign keyset cursor), `verify:collection-tenancy` | R |
| FR-F23-003 | Filtering | `verify:filter-tenancy` (65/65) | R |
| FR-F23-004 | **Idempotency** | `verify:idempotency` (simultaneous same-key creates one row), `verify:device-idempotency` | R |
| FR-F23-005 | Optimistic concurrency | `verify:mutating-tenancy` sensitivity `P3`; `verify:path-id-tenancy` control finding (V01-033) | R |
| FR-F23-006 | Request limits | `MAX_JSON_BODY_BYTES` boundary suite (`payload_too_large`) | R |
| FR-F23-007 | Deprecation | no policy exists; nothing to violate | **—** |
| FR-F23-008 | **OpenAPI** | no OpenAPI document is generated or published | **—** |
| FR-F23-009 | Org context | the four tenancy gates | R |
| FR-F23-010 | Rate-limit headers | no probe asserts the header set | **—** |

## F26 — Migration from Local State (P0) · 8 FR

| FR | Criterion | Evidence | Layer |
|---|---|---|---|
| FR-F26-001 | External IDs | `verify:adoption-privacy`, `schema:p07` | R |
| FR-F26-002 | No silent ownership conversion | `verify:adoption-privacy` (conflict handling refused, nothing stored) | R |
| FR-F26-003 | Secret migration | `verify:adoption-privacy` (API key, private-key classes) | R |
| FR-F26-004 | Automation migration | `smoke:browser` compatibility endpoint | R/H |
| FR-F26-005 | Schema versioning | `verify:migration-prior-state` (populated tables) | R |
| FR-F26-006 | Rollback | `verify:restore` | R |
| FR-F26-007 | Conflict handling | `verify:adoption-privacy` | R |
| FR-F26-008 | Telemetry | `verify:adoption-privacy` (closed field list) | R |

## The summary this produces, stated before the results are read

## Coverage gap or capability gap? — every unproven row, classified

A coverage table cannot tell these apart, and the two demand different work: "write a probe" versus
"build a routed surface". `FR-F19-008` was annotated *"no probe asserts a too-old client is refused"* —
a statement about a probe — and the truth was that the **capability** is absent. So every row below was
classified by asking one question: **does a route exist that makes this reachable?**

| FR | classification | what decided it |
|---|---|---|
| FR-F03-008 bulk operations | **CAPABILITY ABSENT** | no bulk route in the router at all |
| FR-F05-006 security notifications | **CAPABILITY ABSENT** | `notifications` has a table (migration 0012) and `notification_preferences` **is** written (`repositories/webhooks.rs:1015`), but nothing ever `INSERT`s a notification — a V04-008-shaped row: a read path with no producer |
| FR-F19-008 min client version | **CAPABILITY ABSENT**, fails **open** | V04-008 — the guard exists and nothing can arm it |
| FR-F23-008 OpenAPI | **CAPABILITY ABSENT** | no document is generated or published |
| FR-F23-010 rate-limit headers | **CAPABILITY ABSENT** | no response emits a rate-limit header; the only `Retry-After` in the tree is an *inbound* webhook consumer (`adapters/webhooks/`) |
| FR-F04-007 explainability | COVERAGE — observed, **unasserted** | the reason is in the response body; nothing fails if it stops being there |
| FR-F13-005 browser use | **now EVIDENCED**, and proving it found a bigger defect | all six settable controls are enforced (`71/71`, `browser_action_denied`, sensitivity 2/2). `blocked_categories` is unimplemented and rejected `422`. **The surface is unreachable**: `capability_definitions` has no writer, so every browser call is refused `capability_not_defined` — **V04-010** |
| FR-F13-006 computer use | **now EVIDENCED**, same defect | all five settable controls enforced (`computer_action_denied`). `blocked_applications` unimplemented. Unreachable for the same reason — **V04-010** |
| FR-F23-007 deprecation | COVERAGE | enforced on a routed path: `ToolLifecycle::Deprecated => None` (`routes/tools.rs:135`), and `CatalogLifecycle::Deprecated.allows_new_routes()` is false |
| FR-F21-006 timeouts (`S`) | COVERAGE | every adapter sets one; no probe measures an expiry |
| FR-F22-010 design system (`S`) | COVERAGE | `pnpm lint` and a component inventory; no rendered comparison gate |
| FR-F09-007 provider health | WIRED, **BLOCKED** by V01-026 | `HealthState::cooling_down` is called from a production path (`routes/inference.rs:4120`) and `cooldown_until` is persisted (`repositories/ai.rs:226`) — it needs a real upstream to drive |
| FR-F21-008 circuit / cooldown | WIRED, **BLOCKED** by V01-026 | same call site |
| FR-F13-009 network egress | WIRED, **BLOCKED** by V01-026 | the allowlist logic exists; no socket is reachable from this host |
| FR-F12-008 provider reconciliation | **CONFLICT IN THE FROZEN CONTRACTS** | `docs/specs/README.md` marks **F12 as P0**; the requirement's own text (`f12`, line 92) opens "**P1** compare internal usage/cost with provider invoice/export *where API exists*". A P0 spec containing a self-labelled P1 requirement, conditional on an API no provider exposes. **Verification may not resolve this** — settling it means editing a frozen contract, which is the deliberate process. Recorded as a contract conflict and left unproven |

**So of 15 unproven rows: 5 are missing features, 3 are blocked by a measured environmental cause, 1 is
a conflict inside the frozen contracts, and 6 WERE missing probes — three of which are now **closed**:
`FR-F04-007`, and both `FR-F13-005`/`FR-F13-006`, leaving **three** (`FR-F23-007`, `FR-F21-006`,
`FR-F22-010`). The first group is the one that
changes the release decision, and none of the five is a small addition.

That sixth row is worth naming as a class on its own: **a `P0` spec can contain a requirement whose own
text says `P1`.** `README.md`'s priority column and the requirement body disagree, and the release gate
lists "unreviewed drift in frozen client/event contracts" as a hard blocker. Nothing in this campaign
resolves it, because resolving it means editing a frozen contract — the one move this campaign is
forbidden to make. It is recorded so that a human decides it deliberately rather than discovering it
when a gate fails.

### Two corrections this classification forced, both against my own first reading

**`FR-F13-005`/`FR-F13-006` were about to be recorded as a capability gap, and that would have been
false.** The inference was: the `BrowserCapability` enum has four variants (`None`, `Read`, `Interact`,
`ComputerUse`) against **eleven** sub-controls the specs name, so the product must model them coarsely.
It does not — `policy_p05.rs` carries a dedicated `BrowserPolicy` and `ComputerPolicy` with a field per
sub-control. The enum is the *tool definition's* capability class; the policy is a separate struct. A
pattern inferred from a single instance is a hypothesis, and the cheapest thing to do with a hypothesis
is read the other instances.

**`FR-F23-007` was about to be recorded as a capability gap for the same reason** — `Deprecated` looked
like an inert label. It is enforced: `routes/tools.rs:135` returns `None` for a deprecated tool.

Both were caught only because the question was "is it *reachable*" rather than "does the thing exist".

- **15 of 147** P0 `FR-*` criteria are **unproven at the runtime layer**: 13 tagged `—` (no evidence at any layer) plus 2 tagged `S`. The two `S` rows are `FR-F21-006` (timeouts — every adapter sets one, no probe measures an expiry) and `FR-F22-010` (design system — `pnpm lint` and a component inventory, no rendered comparison gate). Per this table's own legend an `S` mapping "does not thereby satisfy" the criterion, so counting only the 13 `—` rows would understate the release decision by two. Of the 15, one (`FR-F19-008`) is **not an evidence gap at all** — the capability is absent — and one (`FR-F04-007`) has runtime evidence that nothing asserts
  of what this repository can run: desktop sign-in (F01-013), bulk membership (F03-008), explainability
  (F04-007), security notifications (F05-006), provider health/cooldown (F09-007), browser- and
  computer-use grants (F13-005/006), network egress (F13-009), minimum client version (F19-008),
  provider reconciliation (F12-008), deprecation (F23-007), OpenAPI (F23-008), rate-limit headers
  (F23-010), the soft budget limit, and the SLO availability target.
- **Two** are partially proven with the missing half named in the evidence: F16-005 support access
  (refusal proven, grant-use recorded UNPROVEN) and F21-004 tracing (SDK installed, spans unverified).
- **The rest** carry at least one runtime gate in this campaign.

That distribution is the release-relevant fact, and it is a statement about **coverage**, not about
defects: a criterion with no gate has not been shown to fail, and this campaign does not claim it has.
