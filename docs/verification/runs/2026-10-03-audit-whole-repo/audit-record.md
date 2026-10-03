# 2026-10-03 — whole-repo audit and repair pass

Commissioned as: *audit the whole repo, find things to fix including security
issues, fix everything, document, PR, merge.* It follows the V05 campaign
(`2026-10-03-v05-whole-site-and-release-security/`) on the same day, and starts
from its merged tree (`1388cc1`) — the V05 findings that were **recorded, not
repaired** are this pass's repair queue, audited rather than inherited.

**Candidate:** branch `audit-repairs` off `1388cc1`. **Environment:** Darwin
27.0.0 / node 24.20.0 / pnpm 12.5.1 / cargo shim 1.93.0 / Chrome 154 /
wrangler 4.137.0. **Migration head after this pass:** `0024` (24 files).

## What the audit covered

| surface | method | result |
|---|---|---|
| CI workflows (`.github/workflows/checks.yml`) | manual review: permissions, triggers, secret handling, action pinning | 1 hardening gap (actions pinned to tags only) — **fixed** |
| Production SPA deployment surface (`wrangler.jsonc` assets, ADR 0010, `smoke-production.mjs`) | manual review + live probe | no auth bypass (`run_worker_first` covers `/api/*`); 1 hardening gap (no security headers on asset responses) — **fixed**; probe itself is sound |
| Deploy pipeline | post-merge run observed: deploy job succeeded on `main` push; live probe confirms production now serves the merged tree | resolved V05's "the deployed tree is not this candidate" — production IS the verified line now |
| Known open findings from V01–V05 (V04-008, V04-010, V01-040/046/047/050, V05-003, FR-F12-008) | re-derived at the code level (grep + read), specs re-read before any repair (F13, F19, F12) | 3 repaired, 1 resolved by note, 3 remain open with concrete next steps (below) |
| Standing security checks | `security::` suite (53 tests), incl. `tenant_audit` (caught 4 unclassified statements from this pass's own SQL), `guarded_column_writers` (caught its own entry going stale), `release_docs` (caught the schema map missing the new migrations) | all green after repairs |
| New SQL | `schema:bind-count`, tenant-audit classification | green |
| Product gates re-run on the repaired tree | see Evidence below | green |

## Repairs

### 1. V04-010 (HIGH) — browser and computer-use policy is REACHABLE (was fail-closed, unreachable)

`capability_definitions` had no writer anywhere, so every browser/computer call
in managed mode was refused `capability_not_defined` before any policy toggle
was read; and the tool-side matchers matched spellings (`browser`,
`cap_browser_use`, `cap_`-stripped) that a real `CapabilityId` (`cap_` + 32
lowercase hex) can never carry — the live-call-behind-a-dead-condition shape,
twice over.

Repaired at three layers:

- **Migration `0023`** seeds the platform catalogue (`browser`, `computer`,
  org_id NULL) with ids that are valid `CapabilityIds` (the ASCII-hex spelling
  of each key, zero-padded — the first draft used `browser` inside the suffix,
  which `CapabilityId::new` rejects and would have re-created the defect).
- **The evaluator matchers** (`has_browser_capability` / `has_computer_capability`)
  resolve a tool's capability id through the catalogue's `risk_class`
  (`CapabilityDefinition` gains `risk_class`; `tool_catalog` projects both
  spellings of each row with the row's class). **`runtime_capabilities`** got
  the same repair one layer down: a device's `browser_use`/`computer_use`
  toggles now cover an identifier whose catalogue row's key they name, instead
  of only a `cap_`-suffix spelling match.
- **The f13 probe** (`verify:tool-policy-deny`) drives the seeded rows end to
  end over real HTTP — the tools are registered THROUGH the platform ids, the
  decision calls claim the set (a claim/set mismatch is `tool_capability_mismatch`,
  found by the probe's own positive control), and the device's toggles cover
  the ids via the catalogue: **71/71, exit 0**. Its stale "capability id cannot
  be set" assertions were rewritten to state the repair.
- Unit regression pins both directions: the catalog-resolved grant, and the
  V04-010 refusal for an uncatalogued requirement.

### 2. V04-008 (HIGH) — the minimum-client-version control can be ARMED (was fail-open, inert)

The comparator, the policy read and the refusal existed since P03; nothing
could write `org_device_policy_settings.min_client_version`. Repaired with a
routed lever on the house patterns:

- **Migration `0024`** adds `version` to the table (optimistic concurrency).
- **`PUT/GET /api/v1/orgs/{org_id}/device-policy`** behind
  `DevicesManage`/`DevicesRead`: the floor is validated against the
  comparator's own parser (`parse_version`, extracted from `version_at_least`
  so the two cannot drift — a minimum the comparator would fail closed on for
  EVERY device is refused `min_client_version_invalid` at the boundary rather
  than stored); `null` clears the floor (staged removal is one request);
  version guard + batch guard sentinel (the `assert_policy_version` shape) +
  audit event (`device_policy.updated.v1`) + idempotent replay.
- **`guarded_column_writers` caught the repair itself**: the moment the
  upsert existed, `an_unwritable_record_stays_unwritable` refused the stale
  entry — the entry is now a `Record` documenting the repair.
- **`smoke:p03` gains 9c–9j** with the attribution design the objective
  demands: the SAME token exchange that succeeded with no floor is refused
  `client_version_too_old` under a floor above the device's version, and
  succeeds again after the floor is cleared — plus stale-write 409 and
  boundary 422 cases. **25/25.**
- The new route is covered by `verify:collection-tenancy`'s router denominator,
  and the four new SQL statements are classified in the tenant audit
  (whose check refused them until they were).

### 3. V05-003 (LOW) — billing not-connected state

A 404 on a billing resource is the expected state of a workspace never
connected to the payment provider. `billing-panel.tsx` maps it to a new
`not_connected` resource status rendering the reference's empty state
(`BillingEmpty`: "Not connected to a paid plan", provider-portal copy) instead
of the error panel. 403 and 503 keep their dedicated states. Typecheck green;
the whole-site sweep re-run covers the rendered result.

### 4. Security hardening (two findings)

- **CI supply-chain**: every third-party action is pinned to the exact commit
  SHA of the tag it referenced (tag kept as a comment so a bump stays
  reviewable). Resolved via the GitHub API, including dereferencing the
  annotated `browser-actions/setup-chrome@v1` tag.
- **Production SPA headers**: `apps/web/public/_headers` (applied by the
  Workers asset bundle) now sends a strict CSP — the app ships no inline
  scripts and self-hosts fonts, so no remote source is needed;
  `style-src 'unsafe-inline'` stays for React's style attributes — plus
  `frame-ancestors 'none'` + `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy`, `Permissions-Policy`, COOP. The workflow itself was
  already sound (read-only permissions, no `pull_request_target`, secrets
  never echoed).

### 5. FR-F12-008 — the frozen-contract drift is recorded, in place

The requirement's own text says **P1** inside the P0 F12 area; V04 carried the
ambiguity as an unproven release blocker because no record said which wins. A
classification note now sits on FR-F12-008 in the spec: the requirement's own
priority statement governs it; the area row governs the rest of F12. No
requirement text changed.

## Deliberately left open (with the concrete next step)

| finding | why not repaired here |
|---|---|
| **V01-050** — `provider_entitlement_projections` read live, write dead; the customer route answers an honest `Unknown` projection | wiring the upsert needs an entitlement-sync design: what observes the provider, on what cadence, and how projections relate to the event ledger. A fake writer would manufacture the very "success over a thing that never exists" the finding names. Next step: a short spec for the provider-sync job, then the upsert is a one-call site. |
| **V01-046** — webhook fan-out has no trigger | wiring it means deciding which events are eligible and whether `webhook.*` may reach customer endpoints, across ~22 route files' transactions (FR-F17-007 ordering). A feature decision, recorded at `fan_out_event_statement`. |
| **V01-047** — the `'run'` usage source writer is absent (reads UNION ALL an empty table) | what counts as billable non-inference usage is a money decision (P05-CR-002 §7/§8). Left to the deliberate process. |
| **V01-040** — staff grant-use surface (ADR 0007 "grant on every use") | implementing staff access to customer context needs its own spec/ADR. Fail-closed today. |
| **INP** | still unmeasurable on this stack (V04). |

## Evidence

| gate | result | log |
|---|---|---|
| `pnpm check` (format, lint, typecheck, vitest + cargo test incl. canaries, schema/null/bind scans, guard probe) | exit 0 after the audit repairs; `rust:check` (clippy + wasm) exit 0 | `evidence/audit-check.log`, `evidence/audit-rust-check.log` |
| `verify:tool-policy-deny` | **71/71, exit 0** with the seeded catalogue and catalog-resolved matcher | `evidence/audit-tool-policy.log` |
| `pnpm smoke:p03` | **25/25** (9c–9j new) | taken mid-pass; rerunnable |
| `pnpm verify:migration-prior-state` | exit 0 over the 24-file ledger incl. 0023/0024 | `evidence/audit-migration-prior-state.log` |
| `pnpm --filter @runlumi/agents-cp-api p08:invariants` | exit 0 | `evidence/audit-invariants.log` |
| `pnpm verify:collection-tenancy` | exit 0 with the new route in the denominator | `evidence/audit-collection-tenancy.log` |
| `verify:mutating-tenancy`, `verify:secret-tenancy` | exit 0 each | `evidence/audit-*.log` |
| `pnpm smoke:browser` | **91/91, exit 0** | `evidence/audit-smoke-browser.log` |
| whole-site sweep | **ALL CHECKS PASSED, exit 0** — the billing not-connected state rendered and screenshotted (`evidence/shots/settings-billing-desktop.png`) | `evidence/audit-whole-site.log` |
| `verify:privilege-escalation` | **exit 2 — harness could not run** (see below) | `evidence/audit-privilege-escalation.log` |

### The privilege-escalation harness failure is environmental — bisected, not assumed

The probe died deterministically at the same case (`POST /api/v1/account/reauth`
→ `fetch failed`, workerd gone with no crash output) on the repaired tree
**three times** — and then **identically on the pre-audit tree `1388cc1`**,
driven from a clean worktree against the same environment. The failure
therefore predates this pass's changes; the product path itself answers when
driven directly (signup → login → reauth against a fresh dev Worker stays
alive and healthy throughout). Disposition per the exit-code discipline: the
gate's most recent valid measurement of the product logic remains the V05
sweep's PASS (same day, 04:44 UTC); this run is a measured **harness/environment
failure**, recorded with its bisect, and re-run of this gate belongs on the
next environment change. The standing checks that cover the same authorization
classes — `verify:mutating-tenancy`, `verify:secret-tenancy`,
`verify:collection-tenancy`, `verify:path-id-tenancy` (V05 sweep), the
privilege unit tests inside `cargo test` — are green on this tree.

## Verdict

The repairable set is repaired with regression proof at the layer that bites;
the standing checks caught this pass's own gaps (unclassified SQL, stale guard
entry, unlisted migrations) and were satisfied rather than weakened; the
deliberately-open set is narrowed to four items, each with a stated next step
that needs a product decision rather than a code change. No spec, verifier, or
frozen contract was weakened; one was resolved by a classification note.
