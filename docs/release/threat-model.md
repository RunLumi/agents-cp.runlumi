# Threat model

## Scope and posture

One Worker serves every tenant. The deployment is a multi-tenant control plane on
Cloudflare Workers + D1, with Queues for dispatch, R2 for private export artifacts,
and a separate SPA served from the edge.

**What this model is.** An inventory of who can act, what they can reach, and which
boundary stops them. Each control names the code that enforces it, because a
boundary nobody can point at is a boundary nobody maintains.

**What this model is not.** It is not a claim that the system is secure. It is the
list of things that would have to be true for an attacker to succeed, so a reviewer
can check the list rather than trust the conclusion. Every "verified" entry below
names a test that fails if the property stops holding.

## Actors

| Actor | Credential | Boundary | Enforced by |
|---|---|---|---|
| Anonymous | none | Public health/meta only | `app.rs` mounts; no route takes `None` for a resource |
| Human member | session cookie | `authorize` over `(Principal, OrganizationContext, MembershipRole, Permission)` | `modules/authorization.rs`; `role_allows` is the single matrix |
| Human admin | session cookie + Admin role | Same function, more permissions | Same. **No separate admin path** — a customer Admin is still an org member |
| Service account | session cookie (an account is a Principal) | Same `authorize` | Same |
| Machine | `lumik_<12hex>_<43b64url>` bearer | `authorize_machine` over `ApiKeyScope` | `modules/machine_identity.rs`; **no conversion to `MembershipRole` exists** |
| Staff | staff credential | `authorize_staff` over `StaffRole`/`StaffPermission` | `modules/staff.rs`; no conversion to `MembershipRole` exists |
| Platform operator | Cloudflare account | Deployment config, D1, secrets | Out of band. `LUMI_PROVIDER_ALLOWLIST` is operator-owned env config |

ADR 0007's load-bearing claim: `Principal` and `authorize` are untouched, so a
machine or staff caller **cannot reach a route that only calls `authorize`**, because
those handlers take `Option<&Principal>` and no conversion into one exists. That is
a compile-time fact, not a review rule.

## Trust boundaries

1. **Edge → Worker.** The SPA is static; the API is the only mutable surface.
   Authorization is server-side on every route. No client-side check substitutes.
2. **Route → domain.** Routes are thin; they parse, authorize, and delegate. Domain
   decision functions are pure and separately tested.
3. **Domain → D1.** Repositories own SQL and bind every dynamic value. The tenant
   column is the boundary, and `security::tenant_audit` checks all 421 statements
   that touch a tenant-owned table.
4. **Worker → third party.** Outbound fetch is the SSRF surface. See below.
5. **Staff boundary.** `/api/v1/internal/*` is a separate path prefix, a separate
   credential scheme, and a separate permission set. `organization_id` on
   `support_grants` and `kill_switches` names the *customer*, not a caller scope.

## Assets, and what leaking one buys an attacker

| Asset | Why it matters | Where it lives | Control |
|---|---|---|---|
| `secret_hash` (argon2id) | Offline cracking | `authenticators.password_hash` | Encrypted? No — hashed. `PasswordRecord` Debug redacted |
| Provider credential secret | Inference spend under the victim's key | Encrypted at rest, AES-GCM | `EncryptedSecret` Debug redacted; never projected |
| API key wire value | Full machine scope for the org | Returned once, never stored | Only 3 projections, one of which is create/rotate |
| Webhook secret | Forged webhooks | AES-GCM ciphertext + nonce only | Plaintext never persisted |
| Export download grant | Bearer read of a customer's exported data | Single-use, expiring, one-shot `TOUCH_GRANT` | `MARK` guarded so a replay is a no-op |
| Session cookie | Full human authority | `HttpOnly`, `Secure`, `SameSite` | Not in any URL, not in any log |
| Data-governance certificate | Proof of deletion | `deletion_certificates` | Immutable |

## The nine ways in, and what stops each

### 1. Cross-tenant read or write

**Attack.** Substitute an id from another organization into a path parameter.

**Controls, strongest first.**
- A tenant predicate on the statement itself. 281 of 421 statements.
- A read that returns the tenant column, so the caller can compare before
  responding. 48 statements.
- A compare-and-set on version or state, so a write cannot land on a newer row.
  32 statements.
- A chain: the id came from an org-scoped read, and the audit follows the chain
  until it bottoms out in a real boundary. 20 statements.
- A platform sweep, bounded by a `LIMIT`, for the two statements that must cross
  tenants. 2 statements.
- Device- or principal-bound, for the two axes that are not organization scope.
  18 statements.

**Verified by** `security::tenant_audit` — 10 tests. It derives the tenant-owned
tables from the migrations (so a new table is audited the day it is created),
requires every statement to carry exactly one class, and asserts each class's
*mechanical* property so a label cannot lie.

**Known limits.** A statement's safety can rest on a caller-side check rather than
a predicate; the audit records those as weak terminals and counts them. It does not
prove routes call the right statement with the right value — that is a call-graph
property needing an integration environment.

### 2. Authentication and session integrity

**Attack.** Steal or forge a session; ride a human cookie from a machine.

**Controls.** Session state is checked on every request, not once at creation.
Passwords are argon2id at the OWASP baseline with a dummy-hash path so a missing
user costs the same as a wrong password. Passkeys are WebAuthn with a ceremony
state that cannot be replayed. A machine must present its own credential: a
machine that borrows a human cookie is attributed to that human in the audit trail,
which is the misattribution F14 exists to stop.

**Verified by** the P02 authentication suite, the P07 fixture suite, and
`security::secret_canary`'s 32 cases (which prove no password hash, recovery-code
hash, WebAuthn ceremony state, or passkey handle is reachable through `Debug`).

### 3. Secret exposure

**Attack.** Read a secret from a log, an error body, a `Debug`, a URL, or browser
storage.

**Controls.** Ten secret-bearing records previously had a `derive(Debug)` that
would print the hash; all are now hand-written and redacting with
`finish_non_exhaustive`, so adding a column later cannot start printing without a
deliberate edit. Every `Display` on an error writes a static string or an enum code.
Provider adapter errors discard the upstream body at the boundary, including on the
mid-stream error path where a provider answers `200 OK` and emits an `error` frame
later. The one-time API key reveal is a pure reducer: `reveal` is the only action
that can put a secret into state and only create/rotate dispatch it.

**Verified by** `security::secret_canary` (32 Rust cases) and
`apps/api/scripts/p09-secret-canary.mjs` (14 cases across 141 web and 166 API
sources). Both are wired into `pnpm test`, and both were proven able to fail by
planting four separate leaks.

**One latent path, deliberately left.** `security_events.metadata` is serialized
raw while `audit.metadata` is sanitized. No secret reaches it today — all 20
construction sites pass bounded server literals. The fix is either a frozen-contract
change (the audit allow-list would drop four client-visible keys) or a security
allow-list edit that deserves its own review. It is recorded here rather than
slipped into a QA packet.

### 4. SSRF / egress

**Attack.** Point a provider base URL, MCP URL, or webhook URL at loopback, RFC1918,
link-local (the cloud metadata address at `169.254.169.254`), or an internal
admin API.

**Controls, in layers.**
- The provider control is `LUMI_PROVIDER_ALLOWLIST`: operator-owned, exact-host,
  empty by default, so it fails closed. A tenant cannot widen it.
- The webhook path re-resolves over DoH immediately before connecting and fails
  closed on an empty answer or any poisoned answer.
- Redirects are `redirect: "error"`, so a 302 to an internal address is a fetch
  error, not a hop. A structural test counts `RequestInit::new()` against
  `with_redirect(RequestRedirect::Error)` so a future call site cannot silently opt
  out.
- A shared blocked-destination table in `core/egress.rs` is mode-free and has one
  test corpus, so the two fetch paths cannot drift apart.

**Two real defects found.** The provider validator hand-split on `://` and handed
the substring to `IpAddr::from_str`, while the runtime's `Url::parse` folds
`0177.0.0.1`, `2130706433`, and `127.1` to `127.0.0.1` — so the range check read a
different host than the transport dialled. And the webhook IPv6 range table was
unreachable dead code, because hosts come back bracketed and `parse::<IpAddr>()`
always failed. Both fixed.

**Verified by** `apps/api/tests/egress_corpus.rs` — 11 tests, 70 hostile inputs.

**Known gap, deliberate.** The plugin `network_destinations` declaration filter is
far weaker than the two fetch guards: 41 inputs the guards refuse, it accepts. It
is not an SSRF — nothing dials a recorded declaration — but a manifest declaring
`http://0177.0.0.1` is recorded and shown to a reviewer as a permitted public
destination. Changing it is a change to a reviewed P07 surface and a frozen fixture,
so it is a coordinator decision, not a security-packet edit.

### 5. Remote code / tool policy bypass

**Attack.** Get a tool executed that policy should have refused.

**Controls.** F13 default-deny: a tool is usable only when a
`PluginToolRegistration` exists for `(package_id, version, tool_id)` **and** policy
permits the package. The absence of a registration row is the denial, so there is no
path where an un-registered tool runs. Privileged tools fail closed in managed mode.
Approval bindings are invalidated by an argument change and by a fingerprint change.
Browser and computer-use restrictions are evaluated independently of any
client-supplied claim.

**Verified by** `modules/tool_policy` (15 tests) and the P07 plugin suite.

### 6. Support / admin privilege abuse

**Attack.** Use a support grant for more than it says, or keep using it after it
should have ended.

**Controls.** A grant names an organization, a reason, a ticket, an explicit
capability subset, and a mandatory TTL bounded at seven days — there is no
representable "permanent" support access. A grant cannot widen the role of its
holder: effective authority is the **intersection** of the role and the grant. A
wildcard capability is refused as a permission decision, not a validation one, so a
client can tell "you may not hold that" from "you sent that wrong". Expiry is
evaluated on **every request**, never once at creation. Five human-only permissions
are refused before scope is consulted.

**Verified by** `modules/staff` (14 tests) and the P07 platform-operations route
tests.

### 7. Supply chain

**Attack.** A compromised or malicious dependency.

**Posture.** Rust: `Cargo.lock` committed, `worker-build --locked` in CI, minimal
crate set (no async runtime, no HTTP client, no crypto beyond `argon2` and a
40-line in-crate SHA-256 that `platform::sha256_hex` cannot serve synchronously).
JS: `pnpm-lock.yaml` with `require-lockfile: true` in CI, Vite plugin count kept
minimal, and no `@radix-ui` anywhere.

**Known gap, accepted.** `p07-schema-invariants.mjs`, `p09-secret-canary.mjs`, and
the egress corpus use `node:sqlite` and `node:test` only — no new dependency, and
both are built into the pinned Node 24 the repo already requires.

### 8. Destructive cross-tenant behaviour

**Attack.** A deletion, export, or purge that reaches another tenant.

**Controls.** A deletion is a **plan** first: `deletion_tasks` is derived from the
data-class registry by walking it in declaration order, so it is deterministic and
reviewable before anything is removed. Account deletion requires leaving or
transferring the last owner. The registry is fail-closed: a class with no
declaration is not actionable. Backups are not selectively rewritten (that is
operationally unsafe), so the real guarantee is bounded by the backup retention
window — stated, not hidden.

**Verified by** `modules/data_governance` and the `0014` schema invariants.

### 9. Irrecoverable data loss

**Attack.** Lose data that was not recoverable.

**Controls.** Published plugin versions are immutable at the database level:
manifest, digest, and package cannot be edited in place. A revoked credential's
reason cannot be blanked, and a revoked or rotated credential cannot be reactivated,
so a revocation cannot be quietly undone. A lifted kill switch cannot be re-engaged
in place. `usage_events` has no UPDATE and no DELETE trigger, so a cost record
cannot be rewritten after the fact. Every mutation is a compare-and-set on version,
so a lost update is refused rather than applied.

**Verified by** the 97 schema invariants, each proven *rejected by the database*
rather than by a code path, and by the 66 triggers catalogued in the schema map.

## What an attacker still needs

To succeed, an attacker needs a defect that is none of the above, or a legitimate
credential. The realistic residual risks are:

- **A defect in a route's call sequence** — passing the wrong id to the right
  statement. The audit classifies statements; it does not trace calls.
- **DNS rebinding on the provider path.** Webhooks re-resolve before connecting;
  providers do not, and the Workers API cannot pin a connection to a validated IP.
  This rests on the allowlist and on the platform's own refusal of internal
  destinations. Unfixable without an egress proxy.
- **A frozen-contract change** that widens a projection. The canary harness catches
  a secret appearing; it does not catch a non-secret field that should not be there.
