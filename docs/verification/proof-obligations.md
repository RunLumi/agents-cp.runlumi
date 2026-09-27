# Proof Obligations

A test case is an implementation artifact.

A **proof obligation** states what must be demonstrated before a claim may be accepted.

Start from the claim, not from existing tests.

## Claim-evidence schema

| Field | Meaning |
|---|---|
| Claim ID | stable verifier identifier |
| Source | spec/ADR/contract |
| Claim | falsifiable statement |
| Risk | consequence if false |
| Failure modes | concrete ways it can fail |
| Minimum proof | V0–V5 |
| Verifier | command/test/probe |
| Evidence | exact output/artifact |
| Mutation/fault | how to test verifier sensitivity |
| Environment | runtime/DB/browser/provider |
| Verdict | PASS/FAIL/UNPROVEN/BLOCKED/N/A |
| Expiry | what invalidates this evidence |

## Evidence expiry

A PASS becomes stale if changes touch:

- the invariant's dependency cone;
- frozen contract;
- migration/schema;
- auth/session semantics;
- policy/entitlement evaluation;
- provider adapter behavior;
- Worker runtime/toolchain;
- browser/desktop consumer;
- the verifier itself.

Do not carry forward PASS just because the target file was untouched.

## Mandatory families

### Tenant isolation

Prove:

- Org A principal + Org B resource;
- Org A context + Project B;
- foreign credential/key/device identifiers;
- list/search/pagination do not leak foreign metadata;
- audit/usage/export remain tenant-scoped.

At least one representative proof must cross HTTP/router/repository, not only a domain helper.

### Authentication/recovery

Prove:

- short-lived server-generated ceremony;
- replay rejection;
- expiry;
- kind binding;
- origin/RP ID binding where applicable;
- server-authoritative credential ownership;
- revoked session/device/authenticator cannot refresh/authenticate;
- recovery does not merge unrelated identities;
- generic enumeration behavior where required.

### Server-side authorization/policy

Attempt privilege escalation by altering:

- org/project IDs;
- roles/permissions;
- policy version;
- model route;
- tool capability;
- entitlement/budget field;
- credential ID.

Server authority must win.

### Secrets

Prove negative space:

- no provider secret in API response;
- no token/auth header in logs;
- no secret in audit;
- one-time secret cannot be fetched again;
- cross-tenant secret IDs cannot be dereferenced;
- export/support paths do not leak values.

Include runtime redaction evidence, not only static search.

### Budgets

Prove:

- hard denial before upstream dispatch;
- concurrent reservations do not trivially overspend;
- actual usage reconciles reservation;
- failures release/reconcile;
- cost attribution goes to correct org/project/principal/run;
- unavailable authoritative state follows spec.

Dangerous mutation: move budget check after dispatch. The verifier must kill it.

### Inference retry/streaming

Prove:

- safe retry only;
- fallback before meaningful output;
- no fallback after stream commit;
- bounded timeout;
- downstream cancellation where supported;
- stable gateway errors;
- provider/route metadata is auditable without secrets.

### Idempotency/concurrency

Prove:

- same key + same semantic request does not duplicate side effects;
- same key + incompatible payload follows documented behavior;
- concurrent updates do not silently lose writes;
- webhook/outbox/automation retries do not duplicate committed effects.

### Data governance

Prove:

- export cannot cross tenants;
- deletion is authorized + idempotent;
- every data class has disposition;
- failures are visible;
- required audit survives;
- private artifacts remain protected.

### Migration/adoption

Prove:

- fresh DB migrates;
- realistic previous DB upgrades;
- invariant probes retain meaning when rerun;
- constraints reject invalid rows;
- local-only works without sign-in;
- adoption is explicit/staged;
- unbind does not destroy/upload local content;
- incompatible versions degrade safely.

### UX truthfulness

In a real browser prove critical flows have:

- no stale org data after switch;
- permission denied distinct from empty;
- loading/error/retry states;
- keyboard/focus;
- destructive consequence copy;
- one-time secret lifecycle;
- no "managed means broken" false state.

### Observability

Prove one request can correlate:

```text
request_id
→ auth/policy
→ domain action
→ external dispatch
→ usage/cost
→ audit/security event
→ response
```

while sensitive values remain absent.

### External compatibility

The desktop client is an independent authority.

Do not claim desktop compatibility until the actual client consumes the contract and passes.

## Minimum mutation set

Before release, in a disposable worktree:

1. allow one denied authorization path;
2. remove one representative org predicate;
3. accept consumed auth ceremony;
4. move budget denial after dispatch;
5. allow fallback after streamed content;
6. bypass one idempotency guard;
7. remove one migration constraint;
8. accept one content-shaped telemetry field.

Each must fail the intended verifier **for the intended reason**.
