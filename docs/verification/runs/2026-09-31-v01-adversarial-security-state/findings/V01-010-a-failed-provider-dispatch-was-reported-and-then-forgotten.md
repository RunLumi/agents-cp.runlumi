# V01-010 — a provider dispatch that never reached the provider was reported, and then forgotten

## Status

**closed** — the cause is logged, with two unit tests holding the log line safe. Found while
trying to prove something else was unreachable, which is how the best findings in this campaign
have arrived.

## Severity

**medium.** Not a security defect and not a money defect: the request correctly fails, the
reservation is correctly released, and the client is correctly told `provider_unavailable`. The
defect is that the operator is told **nothing at all**, so the difference between "this provider
is down" and "this endpoint is misspelled" cannot be made from any evidence available.

## Attack record

| | |
|---|---|
| **Claim ID** | `VI-FAIL-001` (new) |
| **Setup** | real Worker, fresh local D1, a real `openai_compatible` provider created through `POST /catalog/providers` with an `endpoint_url` the catalog accepted, a real model, credential and published route on it, and a real inference request. |
| **Action** | issue one `POST /inference/chat/completions` and then ask **where the failure happened**. |
| **Expected** | something that distinguishes a refused connection from a DNS failure from a bad endpoint — or at minimum a log line naming the endpoint and the cause. |
| **Actual** | the response said `provider_unavailable` and the Worker's log said **nothing about the dispatch**. |
| **Evidence** | `evidence/v01-010-dispatch-error.txt` — the same three runs, each with zero upstream requests, and not one line naming the cause |
| **Verdict** | **FAIL — observability defect.** |
| **Regression gap** | none; two unit tests at `adapters/providers.rs` |
| **Severity** | medium |

## Root cause

`apps/api/src/adapters/providers.rs`:

```rust
let mut response = match response_result {
    Ok(response) => response,
    Err(_) if timeout.as_ref().is_some_and(|signal| signal.aborted()) => {
        return Err(AdapterError { kind: AdapterErrorKind::Timeout, .. });
    }
    Err(_) => return Err(transport_error()),   // <- the cause is dropped on the floor
};
```

`Err(_)` discards the `worker::Error`, which is the **only** thing in the process that knows
whether the socket was refused, the name did not resolve, TLS failed, or the URL was malformed.
By the time the error reaches the route it has been flattened to
`AdapterErrorKind::ConnectionFailed`, and the route maps that to `provider_unavailable`. Every
one of those causes is now the same answer, and none of them is written anywhere.

This is the shape the repository has already been bitten by once, in a comment in
`routes/usage.rs`:

> `report_error` rather than a bare `console_error!` … A swallowed error never throws, so the SDK
> cannot see it on its own — and this is the arm that hid the P07 service-account failure for a
> whole campaign round.

The same rule was not applied here, on a path that handles a third party's endpoint, where the
cause is genuinely external and therefore genuinely worth knowing.

## What it cost

Three probe runs, about forty minutes of wall clock, spent establishing that the Worker could
not reach a host-local HTTP endpoint — with **no evidence to show for it**, because the one
thing that would have said so was being discarded. Each run produced an identical red sheet and
an identical `provider_unavailable`, and nothing distinguished "the socket was refused" from
"the code never tried".

## The fix

```rust
Err(error) => {
    worker::console_error!("{}", provider_dispatch_failure_message(&url, &error));
    return Err(transport_error());
}
```

The message is built by `provider_dispatch_failure_message`, and that is deliberate: **whether a
given test harness surfaces a Worker's `console_error!` is a property of the harness.** Asserting
on the captured log would make the test pass or fail for reasons that have nothing to do with
the product. What the product owes is that the cause is turned into a string at all, and that
the string is safe to emit, and both are testable without any log plumbing.

## Why the log line is safe

- **The credential travels in a header**, and no header is ever formatted into the line. The
  unit test asserts the rendered line cannot contain `authorization`, `bearer`, `api-key`,
  `x-api-key`, `secret` or `token`, so a future edit that started formatting one would fail.
- **The URL cannot carry a token.** `validate_endpoint_url` rejects a base URL with a query or a
  fragment precisely because those are silently dropped from the request URL that gets built.
  That is a real property of the code, not an assumption, and it is the reason the endpoint is
  safe to name.
- The line starts with a fixed `provider_dispatch_failed:` prefix, so it is greppable, and the
  test asserts that too — a log line nobody can find is not a log.

## Regression proof

Two unit tests, at the cheapest layer that can express the claim:

```
adapters::providers::tests::a_failed_dispatch_is_reported_with_its_endpoint_and_cause
adapters::providers::tests::the_dispatch_failure_line_carries_no_authorization_material
```

`cargo test --workspace` → **1005 passed, 0 failed** (1003 before this change).

## What is still missing, and is not a finding

**429, 5xx and a genuinely malformed chunk are still UNPROVEN over HTTP.** `verify:inference-failure`
covers the four seeded `mock://` providers and closes the *money* half of the streaming family,
but no seeded provider produces an HTTP status from a real socket. A probe for the other three
exists and is committed — `apps/api/scripts/v01-provider-fault-probe.mjs` — and it runs a real
HTTP server that **counts the requests that reach it**, so "the provider was called once, and not
retried" would be a measurement rather than an inference.

In this environment it **exits 2** with a named reason: `wrangler dev` here does not route a
Worker's outbound fetch to a host-local HTTP endpoint, so the server is never reached, and every
case in the probe is graded on that server's tally. Reporting four product failures for an
environment that cannot run the harness would be the single most misleading thing the probe
could do, so the reachability control BLOCKS the rest and the exit code says "could not run".

This is recorded as **GAP-007**. It is an environment blocker, not a product defect, and the
distinction matters: nothing about it suggests the product mishandles a 429. The probe is
ready for an environment where the socket is reachable.
