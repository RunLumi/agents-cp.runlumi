# Missing External Proofs — V00, 2026-09-27

These obligations cannot be discharged from this repository. Each is named with the exact
dependency, the command that would produce the evidence, and the verdict that must be used
until it exists. `plan00-verification-system.md` §V06 and `contract-testing.md` §B are explicit:
**unavailable external evidence is UNPROVEN, never a fabricated mock PASS.**

---

## 1. `VI-MIG-002` — local-only survival and adoption privacy (Tier 0)

**Claim.** Local-only Lumi Agents remains possible without control-plane sign-in, and
adoption/unbind does not silently upload or destroy local prompt, file, secret, or history
data. (`core-invariants-v1` `VI-MIG-002`, `external_proof_required: true`; F26 FR-F26-002,
FR-F26-003, FR-F26-006, and the F26 acceptance criteria.)

**Dependency.** The `RunLumi/LumiAgents` desktop repository, at a commit identified by client
protocol/schema version. Not present here. `docs/contracts/p06-automation-lease-v1.md` cites
client paths (`apps/zcode-cli/packages/bootstrap/...`,
`packages/services/src/zcode-agent/...`) that do not exist in this tree.

**What this repository can and cannot say.** It can prove that the *control plane* refuses to
store local content: `p08-invariants.sh` refuses an absolute path in a workspace key, refuses
free-text and path-shaped telemetry reasons, and asserts `adoption_stage_events` has no
content-shaped column. It cannot prove anything about what the client sends, or what the
client keeps locally when the control plane is unreachable.

**Required evidence.**

1. Start the desktop client with the control plane **unreachable** and complete a local-only
   workspace, session, and run. Record that nothing network-dependent blocks it.
2. Capture every outbound request during enrollment/adoption and assert no prompt, file
   content, secret, or history body is present (redact, keep the property).
3. Perform enrollment → rollback and assert the local SQLite/session state is byte-identical
   before and after.
4. Prove a managed project policy cannot be bypassed by a stale local config once a valid
   active policy exists.

**Verdict until then: UNPROVEN.** Not "PASS because the control plane is fine".

---

## 2. `VI-CON-002` — released desktop client compatibility (Tier 1)

**Claim.** Released Lumi Agents desktop clients remain compatible with supported
control-plane protocol versions. (`core-invariants-v1` `VI-CON-002`,
`external_proof_required: true`; F23 FR-F23-001/007; `docs/contracts/desktop-auth-v1.md`;
`docs/contracts/p05-run-protocol-v1.md`.)

**Dependency.** A released client artifact plus `docs/release/compatibility-matrix.md`
evidence. `STATUS.md` references `RunLumi/LumiAgents` PR #31 (`fbb4a09`); that artifact is not
available here and a client-side test result is not independent evidence until the artifact
version is pinned.

**Required evidence.**

1. Run the **real** desktop API client — not a generic `fetch` — against `ecbdac1`.
2. Cover the device-code flow end to end (start → browser approval → PKCE exchange), including
   a second exchange proving `device_code_replayed`.
3. Cover a managed run: session, run, `tool-decisions` allow/require/deny, terminal transition.
4. Run a leased automation occurrence against `p06-automation-lease-v1`, including the
   `ambiguous` path, and assert the second device cannot claim it.
5. Record results by client protocol/schema version in the compatibility matrix.

**Verdict until then: UNPROVEN.** The control plane cannot certify its own consumer.

---

## 3. `VI-OBS-001` (V5 half) — production observability (Tier 1)

**Claim.** Operators can correlate a request across policy, domain, external dispatch, usage,
and audit without logging protected content, **in production**. (F21 FR-F21-001/002,
FR-F21-005; `wrangler.jsonc` `observability.head_sampling_rate: 0.1`.)

**Dependency.** A deployed staging or production Worker with Workers Logs / Trace access.

**What this repository proves.** `pnpm smoke:local` correlates one `request_id` through Vite →
Worker → D1 → outbox → queue consumer → status endpoint, and p05 correlates a run across
timeline, audit, and D1 rows. 15/15 secret canaries and the 32 Rust canaries constrain content.

**Required evidence.** A staging deploy; one request traced end to end through Workers
Observability; sampled logs inspected for protected content; a proven alert on
queue/DLQ depth and budget denials.

**Verdict until then: UNPROVEN** for the V5 half; PASS for the in-repo correlation property.

---

## 4. Live AI-provider dispatch (Tier 0/1, currently unclaimed)

**Claim under test.** F10 acceptance: "One client endpoint can route to at least two
providers"; "A failed first provider can fallback before stream commit"; VI-INF-001 in anger.

**Dependency.** At least two provider credentials and `LUMI_PROVIDER_ALLOWLIST` set. Neither
exists in this environment. With an empty allowlist, `POST /api/v1/inference/responses`
**cannot** dispatch to anything, so every inference claim in the matrix rests on stubbed
adapters and the request/usage accounting around them.

**Required evidence.** A bounded canary: two providers, forced first-candidate failure before
commit (fallback) and after commit (no fallback), TTFT and total latency, and a request-ID
correlation across dispatch, usage, and audit. No customer prompts or secrets.

**Verdict until then: UNPROVEN** for provider-dispatch behaviour. Note that `VI-INF-001` and
`VI-BUD-001` are still **PASS** on their own terms — their verifiers use a deterministic
stream decoder and a structural gate, not a live provider — so this gap is additional, not a
reason to downgrade them.

---

## 5. Billing/payment provider and email delivery (Tier 1/2)

**Claim under test.** F18 subscription-state mapping, F17 notification delivery, F01 email
verification and recovery delivery.

**Dependency.** A payment-provider sandbox and a real mailbox. `wrangler.jsonc` binds
`send_email`, but nothing in the repository inspects a delivered message.

**Required evidence.** One sandbox charge → mapped subscription state → entitlement change →
feature gate; one delivered verification and one recovery email observed end to end.

**Verdict until then: UNPROVEN.**

---

## 6. Production-scale backup/restore (Tier 1)

**Claim.** F21 FR-F21-011: automated backup, restore procedure, periodic restore test, stated
RPO/RTO. RPO ≤ 15 min, RTO ≤ 4 h.

**Dependency.** A D1 database of representative size and a real Time Travel / export window.

**What this repository proves.** `pnpm verify:restore` runs 6/6 checks on a 195 KiB database
with a measured RTO of 3.7 s in this campaign, and its fault-injection case proves the suite
notices a restore that is missing a trigger. That is a correct *rehearsal*, at a size where
RTO is not the interesting number.

**Required evidence.** A restore from a snapshot taken at production-representative size with
measured RTO and RPO, plus a documented rollback/forward-fix for a data-affecting change.

**Verdict until then: UNPROVEN** at production scale (the repository already records this).

---

## 7. Cross-tenant substitution at HTTP, on 82 of the 104 org-scoped routes (Tier 0, in-repo)

This is not external, and it is listed because it is the largest missing proof in the matrix.

**What the reconstruction recorded, and what turned out to be true.** It said `p05-smoke.mjs`
"proves cross-tenant negatives for P02–P05 (device, run, member, session, budget)" and that "no
runtime probe exists for P06, P07, or P08 routes". Reading the script, the first half is wrong:
`p05-smoke.mjs` asserts two cross-tenant negatives on **one** org-scoped route,
`runs/{run_id}`, plus a device case on `/api/v1/devices/runs/…`, which is not org-scoped. The
second half is right and larger than stated — the gap was never P06–P08, it was almost every
org-scoped route.

**What now exists.** `pnpm smoke:p08` (`apps/api/scripts/p08-tenancy-smoke.mjs`) asks each
id-less org-scoped route three times — as a member, as a plain member of another organization,
and as that other organization's owner — and counts a route proven only when the member's own
call succeeded and both outsiders were refused with `404 resource_not_found`. It proves **19 of
21** driven routes, with 0 leaks; the two skips are billing routes where a fresh organization has
no subscription and no granted entitlement, so there is nothing to leak and nothing to
distinguish. The three extra routes over the list-only version are a real project created in org A
and substituted under org B's path.

**What building it found, which is the reason this section was worth closing.** The probe
immediately reported a leak the record's own limit line had been carrying unexamined:
`GET /orgs/{org_id}/projects/{project_id}/access` authorized the caller against the **`org_id` in
the path** and then read the grants with `WHERE project_id = ?1` and no org predicate, so any
organization owner could substitute another organization's project id and read its access grants —
`org_id`, `member_id` and `team_id` included. Repaired with the same
`.filter(|project| project.org_id == org_id)` guard `patch_project`, `create_grant` and
`readable_project` already carried; reverting it turns the probe red again with the leak named.
VFY-011. **A gap that is written down is worth closing precisely because the closure is where the
defect is** — a limit nobody measured is a limit nobody knows the size of.

**What is still missing, exactly.** The router registers **104** org-scoped routes. Twenty-three now
have handler-level evidence. **Eighty-two do not**, and the probe prints the list on every run
so the number cannot drift from the router:

- **54** take a resource id, so each surface needs one real resource created in org B and then
  substituted under org A's path — automations, leases, webhooks, deliveries, credentials,
  routes, model versions, service accounts, adoption bindings, plugins, adoption remediations,
  exports, deletions, sessions, runs, tools, MCP servers, invitations, members, teams. The probe
  now shows the shape on a real project.
- **28** are mutating or id-less actions this probe does not drive — billing cancel/change/
  portal-session, plugin install/approve/block/pin, adoption preview/telemetry, plugin reports,
  ownership transfer, invitations, team mutations, and the platform surfaces.

**Required evidence.** For each of the 54, seed one resource in org B and substitute it under
org A's path, asserting a denial indistinguishable from not-found and that no list or pagination
response leaks B's metadata. For the 28, a body the route will accept.

**A dependency of its own, discovered while closing this.** The service-account and team surfaces
cannot be seeded: `POST /orgs/{org_id}/service-accounts` answers `503 "The usage store is
unavailable."` on a fresh organization — a *usage*-store message on a P07 machine-identity
route, because `machine_identity` reuses `routes::usage`'s scoped-mutation helpers — and
`POST /orgs/{org_id}/teams` answers `409 conflict`, which `commit_scoped_mutation` returns from
exactly one arm, the idempotency claim guard. Both discard the underlying D1 error, so neither
says what failed. Undiagnosed, recorded in VFY-011; until they are, those routes' own create
paths have no runtime evidence either.

**Verdict until then: UNPROVEN at V3** for those 85 routes; PASS at V1/V2 through the SQL
classification, which the tenant audit does enforce. See `findings/VFY-010-…md`.

---

## 8. The P06 export's R2 leg — the local queue does not deliver a published body (Tier 0, partially in-repo)

`VI-DATA-001` needed a verifier that crosses HTTP → R2. That verifier now exists
(`apps/api/scripts/p06-data-smoke.mjs`) and it did its job: it found two critical defects
(VFY-008, VFY-009) that no other evidence could see. Both are fixed.

What it still cannot decide is the object write itself, and the reason is environmental:

- The producer publishes. The Worker log shows `QUEUE lumi-agents-jobs-development 1/1`.
- The handler routes correctly. Its own routing line reports `p06_queue_routed:jobs`.
- The handler receives one message — `batch.messages()` returns length 1.
- The body it decodes carries **no `job_type`**, so it acknowledges the message and the job stays
  `requested` forever.

So the failure is in message *delivery fidelity* in the local simulator, downstream of the code
this campaign can change. Establishing whether that is a simulator artifact or a real defect needs
an environment whose queue round-trips a published message — a staging deploy, or a producer that
sends a string body rather than a `serde_json::Value`.

**Verdict until then: UNPROVEN** for FR-F20-004's artifact half and FR-F20-007's storage
traversal. PASS for everything either side: the request, the durable job and envelope rows, the
tenant boundary, the permission boundary, and the idempotent replay.
