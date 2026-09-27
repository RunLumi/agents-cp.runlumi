# /goal — V01 Adversarial Security and State Verification

## Mission

Try to falsify load-bearing security, money, and durable-state claims.

## Required attack families

### Tenant isolation

For representative resources:

- seed Org A + Org B;
- authenticate as A;
- substitute B resource/project/device/credential/key/export/run IDs;
- exercise detail, mutation, list/filter, pagination, nested routes;
- prove denial does not leak unintended existence/content;
- prove useful security/audit telemetry without secrets.

At least one proof must cross real HTTP/router/repository boundaries.

### Authentication

Exercise:

- expired ceremony;
- consumed replay;
- wrong ceremony kind;
- wrong origin/RP ID where supported;
- revoked passkey/session/device;
- identity-link conflict;
- recovery with active sessions;
- last-login-method removal;
- user-ID substitution.

Do not replace production cryptographic semantics with test-only logic.

### Client privilege escalation

Attempt to modify:

- org/project;
- role/permission;
- policy version;
- model alias/route;
- tool capability;
- entitlement/budget;
- credential ID.

Server authority must win.

### Budget/cost

Prove:

1. hard denial before upstream dispatch;
2. concurrent reservations do not trivially overspend;
3. provider failure reconciles/releases;
4. usage attributed to correct org/project/principal/run;
5. unavailable authoritative budget state follows spec.

Instrument upstream dispatch so "was it called?" is provable.

### Inference streaming

Provider behaviors:

- fail before first event;
- emit content then fail;
- 429;
- 5xx;
- malformed chunk;
- timeout;
- client disconnect.

Prove retry/fallback only when safe.

### Idempotency/races

Test:

- same key + same payload;
- same key + incompatible payload;
- concurrent same-key requests;
- optimistic concurrency conflict;
- outbox/webhook retry;
- automation lease contention.

Assert business side effects, not merely response equality.

### D1/migrations

Apply migrations to fresh + representative prior state. Directly attempt writes constraints/triggers should refuse. Rerun probes designed to be rerunnable and confirm same meaning.

### Adoption/privacy

Try injecting prompt, file path/content, API key, history, MCP secret, arbitrary notes into surfaces that must not carry them.

Prove rejection at parser/API and durable schema where relevant.

## Output

For every attack record:

- claim ID;
- setup;
- action;
- expected;
- actual;
- evidence;
- verdict;
- regression gap;
- severity.

Create findings before repair. Preserve failed evidence.
