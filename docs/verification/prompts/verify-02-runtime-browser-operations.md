# /goal — V02 Runtime, Browser, and Operations Verification

## Mission

Prove the built system across boundaries users/operators actually depend on, not only inside modules.

## Worker runtime

Prefer the current Cloudflare-supported integration harness before inventing a custom one.

Cross:

```text
HTTP -> Worker -> middleware -> domain -> binding/repository -> response
```

without mocking away auth or tenant context.

## Representative vertical slices

1. account/session lifecycle;
2. org/project/resource authorization;
3. managed inference + budget denial;
4. BYOK metadata path without secret exposure;
5. tool-policy allow/deny;
6. automation + lease/retry;
7. webhook/outbox;
8. export/deletion;
9. migration/adoption;
10. one admin/support action with audit.

E2E proves wiring. Lower layers should cover the combinatorial matrix.

## Browser verification

Use a real browser for primary routes. Verify:

- loading;
- empty;
- success;
- permission denied;
- server error;
- retry/recovery;
- keyboard navigation;
- visible focus;
- narrow layout;
- destructive confirmation;
- stale data after org switch;
- one-time secret lifecycle.

Accessibility scanners help but are incomplete. Pair them with keyboard/focus/manual checks on critical paths.

Compare changed surfaces with `DESIGN.md` and relevant `docs/screens/**`.

## Observability

For representative request IDs prove correlation across:

- request;
- auth/policy;
- domain action;
- external dispatch/queue;
- usage/cost;
- audit/security event;
- response.

Inspect emitted records for forbidden sensitive content.

## Failure injection

At external adapters inject:

- connect failure;
- timeout;
- 429;
- 5xx;
- malformed response;
- queue/webhook retry;
- downstream disconnect.

Verify stable errors, bounded retry, no duplicate side effect, correct reconciliation, useful trace, and no secret leakage.

## Performance

Measure against repository budgets:

- initial JS/CSS;
- changed route chunk;
- Worker bundle;
- representative API latency excluding controlled upstream time;
- inference TTFT/total with deterministic stub;
- main-thread long tasks on critical browser flow.

## Output

Record commands, environment/runtime/browser versions, request IDs, screenshots/traces where useful, injected failures, measured budgets, and verdict per claim.

No browser/runtime available => affected claims are **UNPROVEN**, not static-markup PASS.
