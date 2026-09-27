# Release Verification Gate

Use for a release candidate, not every small PR.

## Pin the candidate

Record:

- commit SHA;
- Worker/runtime/toolchain;
- migration head;
- web build artifact;
- contract versions;
- desktop client versions tested;
- provider/billing/webhook sandbox versions where applicable.

## Hard blockers

Release is blocked if:

- any Tier-0 claim is FAIL, UNPROVEN, or BLOCKED;
- a P0 acceptance criterion has no evidence mapping;
- cross-tenant access is possible;
- auth/recovery has replay/identity-confusion gap;
- secrets unexpectedly appear in client/log/audit;
- hard budget dispatches before denial;
- inference falls back after committed output contrary to protocol;
- destructive operations lack authorization/idempotency evidence;
- frozen client/event contracts have unreviewed drift;
- fresh or upgrade migration fails;
- local-only/adoption privacy is unproven;
- rollback/forward-fix is unknown for data-affecting change;
- a meaningful Tier-0 mutant survives.

## Gate

### Repository integrity

- [ ] clean checkout reproduces install/build
- [ ] `pnpm check`
- [ ] `pnpm build`
- [ ] Rust WASM check
- [ ] Worker dry-run/build artifact
- [ ] no unexpected dependency/runtime drift

### Database

- [ ] fresh D1 migrations
- [ ] upgrade from realistic prior snapshot
- [ ] schema invariant probes
- [ ] rerun semantics understood
- [ ] rollback/forward-fix documented

### Authentication/tenancy

- [ ] passkey/password flows
- [ ] expiry + replay rejection
- [ ] wrong origin/RP ID where testable
- [ ] session/device/authenticator revocation
- [ ] cross-tenant substitution matrix
- [ ] stale org context
- [ ] machine identity isolation
- [ ] recovery/step-up critical paths

### Policy/secrets/tools

- [ ] client cannot override server authorization
- [ ] credential IDs cannot cross tenant
- [ ] secrets absent from responses/log/audit
- [ ] tool/browser/computer-use denial enforced
- [ ] admin/support authority + audit

### Inference/budgets

- [ ] budget denial before dispatch
- [ ] concurrent reservation behavior
- [ ] fallback before commit
- [ ] no fallback after commit
- [ ] timeout/cancellation
- [ ] usage/cost attribution
- [ ] route publish/rollback
- [ ] provider error normalization

### Async/billing

- [ ] automation lease/idempotency
- [ ] webhook signature/retry/dedupe
- [ ] outbox retry no duplicate effect
- [ ] entitlement downgrade behavior
- [ ] billing event replay/idempotency

### Data governance

- [ ] export authorization
- [ ] deletion authorization/idempotency
- [ ] every data class disposition
- [ ] private artifacts protected
- [ ] retention/deletion failure observable

### Browser/UX

- [ ] real browser primary flows
- [ ] org switch no stale data
- [ ] loading/empty/error/permission
- [ ] keyboard + visible focus
- [ ] accessibility scan + manual critical-path check
- [ ] narrow layout
- [ ] destructive confirmations
- [ ] one-time secret lifecycle
- [ ] visual comparison for changed primary screens

### Operations

- [ ] request IDs
- [ ] end-to-end trace correlation
- [ ] no sensitive logs
- [ ] dependency failure stable errors
- [ ] retry/timeout ceilings
- [ ] performance/bundle budgets
- [ ] diagnostics useful and non-sensitive

### External Lumi Agents

- [ ] actual client version tested
- [ ] browser/device authorization
- [ ] managed workspace/run
- [ ] local-only startup with control plane unavailable
- [ ] no silent local content/secret/history upload
- [ ] compatibility matrix updated

### Test-strength sample

- [ ] authorization mutant killed
- [ ] tenant-query mutant killed
- [ ] auth replay mutant killed
- [ ] budget-before-dispatch mutant killed
- [ ] stream-commit mutant killed
- [ ] migration/privacy mutant killed

## Exit record

Record:

- PASS / FAIL / UNPROVEN;
- unresolved findings by severity;
- unproven external claims;
- exact evidence/commands;
- known limitations;
- rollback/forward-fix plan;
- verifier identity/session if available.

Do not use total test count as the release verdict.
