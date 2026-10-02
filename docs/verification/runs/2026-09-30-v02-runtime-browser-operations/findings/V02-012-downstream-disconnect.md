# V02-012 — downstream disconnect: headers arrive, then the connection dies

**`pnpm smoke:browser` 90/90, exit 0, stable over three consecutive runs · failure-injection row 7 closed**

## Why this is a different case from the connect failure, not a duplicate

V02-002 fails the request *before anything is sent*. Here the pause fires at Response stage —
**after the Worker answered the headers** — and the request is then failed with
`ConnectionAborted`. The browser received a status line and then nothing it could use.

An app that handles one does not necessarily handle the other. The distinctive failure of this
fault is a **stuck loader**: the response existed and then broke, and a code path that handles
"rejected" but not "broke mid-body" leaves the spinner up forever — or a retry that reuses a
half-read body, or a cache that stores the partial response. The assertions are shaped by that:
the error state must appear (and the waitFor reads the loading text too, so a stuck loader fails
the case explicitly rather than as a timeout), and the retry must work (the failed attempt must
not have poisoned anything).

## What is asserted

| assertion | result |
|---|---|
| a mid-body disconnect renders an announced ERROR state, not a stuck loader | PASS |
| it offers a RETRY | PASS |
| **CONTROL** — the session recovers through the app's own retry once the network is whole | PASS |

The driver gained two options to do it: `stage` (`Request` vs `Response`) and `errorReason`
(default still `ConnectionFailed`). The disconnect uses `stage: "Response"` with
`ConnectionAborted`.

## What is NOT established — stated before anyone has to ask

- **No product-side sensitivity proof.** This class has been watched to report FAIL only on nothing
  at all yet — it passed on its first run. Like eleven of the twelve browser states, it is a check
  that has never been watched to fail.
- **Only the session read is covered**, same as V02-002 and V02-010. A disconnect mid-mutation, or
  mid-stream on an inference response, is not driven.
- **The local Worker serves headers and body effectively together.** The abort is genuine at the
  protocol level (CDP pauses at Response stage before dispatching to the renderer, and the request
  is failed there) — but this is not a slow stream cut in half. A disconnect ten seconds into a
  large download is a harsher fault than the one driven here, and the verdict does not cover it.
- **Bounded retry and reconciliation** (the objective's loop properties) remain unproven: they need
  a fault that repeats, which needs a provider-shaped adapter, which is the part most likely to
  stay blocked.

## The failure-injection ledger after this

| # | injection | verdict |
|---|---|---|
| 1 | connect failure | **PROVEN** (V02-002) |
| 2 | timeout | **PROVEN, narrow** |
| 5 | malformed response | **PROVEN** (V02-010) |
| 7 | **downstream disconnect** | **PROVEN, narrow** (this finding — session read, fast local body) |
| 6 | queue / webhook retry | **PARTIAL** — replay proven; delivery-failure injection BLOCKED |
| 3, 4 | 429, 5xx | **BLOCKED** — V01-026 |

Four of the seven are now measured without any outbound socket. The three that remain need one.
