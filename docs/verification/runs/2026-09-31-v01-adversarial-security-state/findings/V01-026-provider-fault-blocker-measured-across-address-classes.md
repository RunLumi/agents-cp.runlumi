# V01-026 — GAP-007's blocker, measured across three address classes (and a red sheet I created and removed)

## Status

**GAP-007 remains BLOCKED**, and that is now a *measured* verdict rather than an inference from one
untried address. No product defect was found, and none is claimed.

## Why this was attacked at all

GAP-007 has been recorded as: *"`wrangler dev` here does not route a Worker's outbound fetch to a
host-local endpoint, so the reachability control blocks the rest."* That sentence is a general claim
about host-local endpoints, and the evidence behind it was **one address** — `localhost`.

This campaign has now closed two gaps by refusing to accept a recorded blocker at face value:

- **GAP-006** was closed by *falsification* — the predicted race was written as a defect, and the
  attack showed the invitations path was correct;
- **GAP-008** was recorded as environmental ("the probe needs an entitled organization") and turned
  out to be **V01-023**, a high-severity defect sitting directly behind it.

So the question was worth asking: is "host-local" the blocker, or is it *loopback*?

## What was tried, and what it measured

`v01-provider-fault-probe.mjs` now binds its fault server to `0.0.0.0` and sweeps candidate hosts,
building a real provider + model + credential + published route for each and asking the **server's own
tally** whether a request arrived:

```
local fault server listening on 0.0.0.0:64656; candidate hosts: 127.0.0.1, localhost, 192.168.1.4
reachability via 127.0.0.1:  http=503 server_calls=0
reachability via localhost: http=503 server_calls=0
reachability via 192.168.1.4: http=503 server_calls=0
```

Three address classes, zero calls on all of them:

| class | why it is a different destination | result |
|---|---|---|
| `127.0.0.1` | IPv4 loopback | 0 calls |
| `localhost` | a **name**, which may resolve to `::1` first — the probe's own comment records that a server bound only to `127.0.0.1` is then refused | 0 calls |
| `192.168.1.4` | the machine's own **routable** address, not loopback at all, with the server bound to every interface | 0 calls |

So the blocker is **not** "workerd refuses loopback" and **not** "the name resolved to the wrong
family". It is that this environment's Worker runtime cannot make an outbound fetch to **any**
address on the machine that is running it. The third row is what turns a hypothesis into a
measurement: `192.168.1.4` is not loopback by any definition, and the same server, on the same
interface, saw nothing.

**The verdict is unchanged — BLOCKED — and the reason is now three times wider than it was.**

## The harness regression this attempt created, and removed

The first version of the refactor **exited 1 with a red sheet**: `37/43`, six failures, all reading
"the provider was called 0 times".

That is the failure `AGENTS.md` names explicitly for this gate — *"a red sheet from this probe would
be four product failures for an environment that cannot run it"* — and I produced it by moving the
control's verdict out from under the early `BLOCKED` bail. Every one of those six failures was
**true and meaningless**: the endpoint was never reached, so "the provider was not called" is exactly
what an untested product also reports.

It is worth recording as a finding rather than as a slip, because of *how* it happened. The refactor
was trying to make the probe **stronger** — sweeping more hosts — and the strengthening silently
removed the exit-2 path, because the bail and the verdict had been living in the same `if` block.
Adding a control deleted a safety property three lines away from it. The restored shape separates
them:

- the **verdict** is `expect(...)` on `reachable !== null`, printed with the whole sweep;
- the **bail** is a separate `if (reachable === null) { probe.finish(2, ...); return; }`.

Now: `exit 2`, `25/26`, one named control failure, and the log states the sweep. The general rule is
the campaign's own, restated by this episode:

> **Widening a probe's reach can remove the exit that distinguishes "the product failed" from "the
> probe could not run".** Those two are the same exit code in a healthy harness and they are not
> allowed to converge. Any change to a control has to re-check the bail it used to sit inside.

## What is still missing, precisely

Unchanged, and now honestly scoped: **429, 5xx, and a genuinely malformed chunk over a real socket**,
which is the only way to prove `max_retries: 0` costs exactly one upstream call rather than inferring
it from Worker-side state. Everything else in the streaming family is measured —
`verify:inference-failure` is 65/65 for fail-before-output, timeout, output-then-fail and client
disconnect, and `smoke:p05` drives the no-fallback-after-output claim on an `ordered_fallback` route.

`v01-provider-fault-probe.mjs` is written, controls its two hard problems (the endpoint must be
reached; a malformed body must be distinguishable from an empty one), and now sweeps every address
class available to it. What it needs is a Worker that can open an outbound socket to a host it does
not share a kernel with — a second `wrangler dev` Worker on a routable port, a container, or a tunnel.
That is an environment change, not a code change, and the probe will run unchanged when there is one.
