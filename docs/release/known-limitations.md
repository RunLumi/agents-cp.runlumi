# Known limitations

Everything here is a real gap, with what it costs and what would close it. Nothing
is listed because it seemed unimportant; if it is here, it is either a residual
risk or something a user could notice.

Ordered by what would hurt most if it bit.

## Security

### The plugin declaration filter is much weaker than the fetch guards

`PluginPermissionManifest::rejects_destination` accepts **41 inputs** that both
fetch-path guards refuse: alternate IPv4 spellings (`127.1`, `0177.0.0.1`,
`2130706433`), IPv4-mapped IPv6 (`[::ffff:127.0.0.1]`), ranges outside its three
predicates (`0.0.0.0`, `100.64.0.1`, `198.18.0.1`), and split-horizon names outside
its four entries (`.internal`, `.home.arpa`, `.onion`). All share one root cause: it
splits by hand and hands the result to `from_str`.

**It is not an SSRF** — nothing dials a recorded declaration. **But** a manifest
declaring `http://0177.0.0.1` is recorded and shown to a reviewer as a permitted
public destination, which is a governance failure even though it is not a
connectivity one.

**Why it is not fixed here.** Changing it changes a reviewed P07 surface and a frozen
fixture, and the P07 handoffs record two deliberate non-changes in this area. That
is a coordinator decision, not a security-packet edit. The corpus
(`apps/api/tests/egress_corpus.rs`) asserts the current behaviour in **both**
directions, so it cannot silently tighten either, and its failure message says so.

**To close it:** adopt the shared `core::egress` table for the declaration filter
too, and raise a Change Request for the fixture.

### `security_events.metadata` is not sanitized

`repositories/security.rs` serializes `event.metadata` raw, while
`repositories/audit.rs` runs it through the allow-list. **No secret reaches it
today** — all 20 construction sites pass bounded server literals, and the
secret-canary harness scans them.

**Why it is not fixed here.** The two available fixes are both wrong for this
packet: applying the audit allow-list would silently drop `device_label`, `method`,
`purpose`, and `provider` from a client-visible response (a frozen-contract change
needing `change-request.md`), or adding those four keys to the F16 audit allow-list
is a security-allow-list edit that deserves its own review.

**Residual risk:** a future engineer adds a metadata key carrying user input, and
nothing stops it. That is the actual exposure — not today's data.

### DNS rebinding on the provider path

Webhooks re-resolve over DoH immediately before connecting and fail closed on an
empty or poisoned answer. **Providers do not.** A wildcard-DNS name that resolves
inward is held only by `LUMI_PROVIDER_ALLOWLIST`.

**Why it cannot be fully closed:** the Workers fetch API cannot pin a connection to
a validated IP, so a validate-then-connect gap is structural. This rests on the
allowlist (operator-owned, exact-host, empty by default) and on the platform's own
refusal of internal destinations. Closing it properly needs an egress proxy, which
is a different architecture.

### The static half of the secret canary matches field *names*

A rename defeats it. That is why the runtime canaries are the primary check and the
static scanner is the backup, and why the registry is pinned against shrinkage. A
secret stored in a field named something innocuous would pass the static half; the
runtime half would catch it only if a canary value flowed there.

### Host-target only

The canary proves type renderings — `Debug`, `Display`, and JSON. It cannot prove
that no platform ever logs a value.

## Reliability

### `database_error` classifies D1 failures on substrings

`routes/support.rs` treats any platform text containing `UNIQUE`, `constraint`, or
`CONFLICT` as `409 Conflict` and everything else as `503`. A D1 outage whose text
happens to contain one of those is reported as a **permanent** conflict.

**The fail-closed direction holds** — never a success, never a leak, both asserted.
The harm is that a client retrying only on 5xx will treat a transient outage as
permanent.

**Why it is not fixed here:** classifying on structured D1 error codes changes an API
error code for existing clients, which `plan00 §17` says needs a Change Request.

### Queue retries are not durably reconciled with the job row

The jobs queue retries up to 8 times *before* a message reaches the dead-letter
queue, and those 8 attempts do not each increment the durable `attempt` column. So
`queue_job_envelopes.attempt` under-reports the true attempt count for a job that
died at the queue level.

**Consequence:** an operator reading `attempt = 1` on a dead-lettered job should
read it as "at least 1". The terminal state and the error code are still correct,
which is what the incident response depends on.

**To close it:** reconcile the durable attempt from the DLQ message's
`attempts` attribute on the terminal write.

## Operations

### The `JOBS_DLQ_NAME` fix is structurally tested, not behaviourally tested

The new dead-letter consumer needs a live `Env` and two real queues, so its tests
assert the **routing order, record-before-acknowledge, and redeliver-on-store-failure**
properties by reading the source. That catches a regression in the shape; it does not
prove Cloudflare delivers to the branch.

**To close it:** `wrangler dev` with both `lumi-agents-jobs` and
`lumi-agents-jobs-dlq`, a deliberately failing handler, and an assertion that
`queue_job_envelopes.state = 'dead_letter'`.

### No scheduled reconciliation between the two retry budgets

See above. A single sweep owns the durable state; the queue owns the transport
retries, and the join between them is a reconcile that does not exist yet.

## Verification

### The budget ordering is proven structurally, not at runtime

This was recorded as PARTIAL and is now narrower than that. The contract's mutation —
move the budget decision after dispatch — is a **compile error** on this code, because
the dispatch metadata consumes `budget_decision_value`, a binding the budget match
produces. The ordering is a data coupling, not a convention, and the verifier that
fails is rustc.

What the compiler cannot catch is **neutering the scrutinee**:
`match budget_admission.decision` → `match P05BudgetDecision::Allow` has the same type
and compiles, so every decision takes the Allow arm and a denied request is dispatched.
That is covered by a structural gate in `p09_failure_tests` and by a campaign case
that applies exactly that mutation.

**The residual, stated plainly:** the gate is V1 — source text. A future rewrite that
stopped carrying the decision through the dispatch metadata would reintroduce the gap,
and the compiler would not object, because the coupling it relies on is the thing that
would be gone. Four assertions guard it (one dispatch site, the order, both
non-admitting arms diverging *and* recording, and the metadata still carrying the
decision), and each names its own failure.

**To close it properly**, either:

- a D1-backed route test with a mock endpoint that fails if it is ever called after a
  denial — the same BLOCKED row as the browser pass and the staging deploy; or
- a **permit type**: have the budget decision produce a value that `dispatch` cannot be
  called without, so the coupling is in the signature rather than in a struct field
  someone can stop filling in. That is a real improvement and a change to a money path,
  so it is a follow-up rather than something to do inside a verification PR.

### Three Tier-0 invariants have assertions but no adversarial test

VI-AUTH-001 (ceremony replay) and VI-AUTH-002 (revocation mid-request) have test
coverage and no mutation case. VI-UX-001/002 and VI-OBS-001 are BLOCKED on a browser
and a deployed environment.

### The static null-check scan is V1, not V3

`p09-null-check-scan.mjs` finds the *shape* of the SQLite NULL-passes-`CHECK` hole by
reading DDL. It is how the class was sized — 108 tables, 166 `BETWEEN`-bearing `CHECK`
blocks, one candidate — and the per-case probes in `p07-schema-invariants.mjs` are
what prove a fix. It also needed three corrections to stop crying wolf, and its
`--ignore-adjudications` flag exists so the proof step is a supported operation rather
than a hand-edit.

## Performance

**No field metrics were measured.** LCP, INP, CLS, Worker p50/p95, D1 query count
and latency, TTFT overhead, streaming memory, and fallback latency all require a
deployed environment. None was available.

What *is* measured and gated in CI: initial JS **100.11 KiB** gzip (budget 170),
initial CSS **8.72 KiB** (35), largest route chunk **40.17 KiB** (80), and both P07
chunks at ~16.6 KiB. No budget was raised to make a number pass. See
`performance.md` for the full table and what each unmeasured metric would take.

**The list routes are bounded and cursor-paginated**, so a list cannot be unbounded —
but the *measured* render cost of a 10,000-row admin table is unknown, because no
browser was attached.

## Product scope

### P08 is not implemented

LumiAgents migration and adoption — local-to-managed migration, the F26 surface — is
not built. The **server-side seams** for it are: `POST /plugin-reports` (a report is
evidence, never authority) and `GET /api/v1/machine/whoami`.

**No LumiAgents repository was touched.** Both seams are contracts that a host
implements against, and neither has been exercised by anything but this
repository's own tests.

### F06 is frozen-not-built

Domains, SSO, and SCIM. The entitlement keys exist and default to `false`, so the
gating seam is complete without schema, and the contract is frozen in full in
`P07-CG.md` — implementing it is mechanical rather than a fresh design exercise.

### No internal operations console

The staff boundary, support grants, feature flags, and kill switches are implemented
and tested at the API and domain layers. Nothing renders them; there is no staff user
to need it. This is why `routes/internal.rs` needed its own tests — there is no
decoder on the other side to catch a projection mistake.

## Things a reader might assume and should not

- **That the tenant audit proves routes are safe.** It proves the *statements* are.
  A route passing the wrong id to the right statement is a call-graph property it
  cannot see.
- **That 97/97 storage invariants means the feature is safe.** It means 97 declared
  behaviours match the DDL.
- **That a `reserved` budget hold is spending.** It is not — admission filters live
  holds by `expires_at > now`. It is a bookkeeping row, and the sweep expires it.
- **That an expired flag is just off.** Expiry is checked *first*, so it reports
  `expired` and tells an operator why.
- **That a block is the same as a refusal.** A block records the organization's
  reason; a managed-mode expansion refusal records the candidate version and the
  reason, and installs nothing.
