# Compatibility matrix

## Supported clients

The web app and the API ship together from one commit, so there is no version skew to
support between them. What follows is the *external* surface: what a client may rely
on, and what happens when it moves.

### API versioning

| Aspect | Contract | Notes |
|---|---|---|
| Path prefix | `/api/v1/...` | Frozen across P01–P07. P07 added **routes** under the existing prefix, never a new one |
| Stability | Additive within `v1` | A new optional field, route, or enum value is compatible |
| Breaking change | Requires `/api/v2` | And a Change Request per `plan00 §17` |
| Error envelope | `{"error": {code, message, request_id, details}}` | Frozen. `code` is a stable enum; `details.reason` is the finer-grained branch key |
| `request_id` | On every response, and in every log line | The join key for every incident query |
| Deprecation | None has occurred | No deprecation notice has ever been needed |

### What a client may rely on

**Stable — a change here is breaking.**

- Every `error.code`. A client may branch on it.
- Every `details.reason`. Finer-grained, and stable.
- Idempotency: `Idempotency-Key` on mutating routes, with `InProgress`,
  `FingerprintConflict`, and `Replay` as distinct outcomes.
- Cursor pagination. Cursors are opaque and stable; offsets are not offered.
- Optimistic concurrency: a `version` on every mutable row, and a `409` on a stale
  one rather than a lost update.
- The one-time-secret contract: the plaintext is returned **once**, by create and
  rotate only.

**Stable in shape, additive in content.**

- JSON projections. New optional fields may appear. **Clients must ignore unknown
  fields** — this is why every decoder in the app is an allowlist that copies named
  fields and never spreads.
- Enum fields. A *new value* may appear on a field that today has a known set. A
  client must not treat an unknown value as a success.

**Explicitly not a contract.**

- Error *messages*. They are prose, for humans. Branch on `code`.
- Manifest *content*. Plugin manifests are tenant data, not a schema.
- Internal SQL. Obviously.

### Row-version and rollback compatibility

| Direction | Compatible? | Why |
|---|---|---|
| New Worker + old schema | **Yes** | No migration from P02 onward alters a table an earlier phase created. A new route's tables are simply absent, and the route is not mounted in the old code |
| Old Worker + new schema | **Yes, with the deploy order below** | New tables are unread by the old code. This is what makes rollback possible |
| Migration rollback | **N/A** | There are none. Rollback is a Worker rollback |

**Deploy order when migrating:** apply migrations, then deploy the Worker. The
reverse leaves a new Worker querying tables that do not exist yet.

**Rollback order:** deploy the older Worker. Do not attempt to un-migrate. The newer
tables remain, harmless and unread — which is a far better failure mode than a
down-migration dropping a column a still-running Worker reads.

## Third-party and platform dependencies

| Dependency | Version | Pinned by | If it changes |
|---|---|---|---|
| Node | `>=24 <25` | `package.json` `engines`, CI `runtime: node@24` | `node:sqlite` (both audit harnesses) and `node:test` are built in. A Node major bump breaks the harnesses |
| pnpm | `12.5.1` | `packageManager` | Lockfile format |
| Rust toolchain | stable | `actions-rust-lang/setup-rust-toolchain` | `worker-build` must install for the new target |
| `worker` / `worker-macros` | `0.8` | `Cargo.lock`, `worker-build --locked` | **The axum bridge and the `#[event]` macros.** Highest-risk dependency in the tree |
| `axum` | `0.8`, `default-features = false` | `Cargo.toml` | Handler and extractor signatures |
| Cloudflare Queues | at-least-once | platform | Duplicate delivery. Every consumer deduplicates; a change to at-most-once would be an improvement, not a break |
| Cloudflare D1 | — | platform | See below |
| `wrangler` | `4.137.0` | CI | Build only |

**`worker` is the dependency to watch.** Every D1-backed handler needs
`#[worker::send]`, and without it the `Handler` bound fails with
`the trait Handler<_, _> is not implemented` and **no note at all** — the anonymous
`!Send` future is inside a `js_sys::JsFuture` and rustc cannot name it. Two handlers
were lost to this during P07. A `worker` major bump should be treated as a
migration, not a version bump.

### D1 behavioural dependencies

These are not versions but they are assumptions that would break silently:

- **Foreign keys are enforced.** SQLite resolves them immediately. Every
  schema-invariant probe depends on a fixture being valid, or it fails for the wrong
  reason.
- **`json_each` is available.** The F25-004 policy-conflict query depends on it.
- **Trigger semantics for `UPDATE OF <col>`.** A trigger watching only `status` does
  not fire on `UPDATE ... SET revoke_reason = NULL`; one P07 defect was exactly
  this. Both columns must be watched.
- **`WAL` and concurrency.** Compare-and-set is the correctness mechanism on the
  async path, so a D1 change that weakened isolation would be a correctness
  regression, not a performance one.

## Provider compatibility

| Aspect | Contract | Consequence of a mismatch |
|---|---|---|
| Streaming | Must emit `data: [DONE]` | **Now `upstream_invalid_response`.** See below |
| Base URL | Must be an `LUMI_PROVIDER_ALLOWLIST` host | `host_not_allowlisted`. The allowlist is operator-owned, exact-host, empty by default |
| Redirects | Not followed | A 3xx is an error, not a hop |
| Error bodies | Discarded at the boundary | A provider that expects its error text echoed will see a stable code instead. Correct, and worth stating |

**The one behaviour change in this release, and it is deliberate.** A provider stream
that ends **without** `data: [DONE]` used to be recorded as a **successful** run with
the budget reservation committed at the full upper bound, and it emitted
`usage.recorded` and `inference.completed` — overcharging the tenant and asserting
something false in the audit trail. It is now `upstream_invalid_response`, the
reservation is **released**, and the body ends with an `error` frame.

A non-conforming provider that previously appeared to work will now fail visibly. That
is the correct reading of the protocol, and it matches how a timeout and a downstream
cancellation already behaved — but it belongs in the release notes, because it is the
kind of change that surfaces as "we broke a customer" rather than as a bug fix.

## Browser support

| Target | Support level | Notes |
|---|---|---|
| Evergreen Chrome, Firefox, Safari, Edge | Supported | WebAuthn/passkeys and `crypto.subtle` are the floor |
| Safari (WebAuthn) | Supported, conditional | Platform authenticator availability varies by version |
| Mobile | Best effort | The control plane is a desktop-first admin surface |
| **No JavaScript** | Not supported | The SPA requires JS. There is no server-rendered fallback |

**Untested in a browser.** No P06 or P07 surface has been rendered in a browser at all
— none is attached to this environment. Layout, focus rings, and the async states are
unverified by observation, though the async states are covered by unit tests and a
keyboard trap found during P07 development was fixed. This is the same debt across
three phases and it is the first thing a reviewer with a browser should check.

## Support matrix, stated as a policy

| Client | Policy |
|---|---|
| Web app at the same commit as the API | **Supported.** One deployment, one version |
| Web app one commit behind | **Supported.** The API is additive within `v1`; the app tolerates unknown fields by construction |
| Web app more than one commit behind | **Not supported.** No deprecation window exists because none has ever been needed |
| A hand-written API client | **Supported** for stable fields; must ignore unknown fields and must not branch on messages |
| LumiAgents host | **Seams only.** `POST /plugin-reports` and `GET /api/v1/machine/whoami` exist and are tested; no host implements them yet |

**Honest note on the "one commit behind" row.** It holds because the API has only
ever been additive, and because every decoder is an allowlist. It has not been
*tested* against a deliberately older build, because no such build exists to test
against. Treat it as an argument, not a measurement.
