# V02-011 — slice 5 closed: the tool-policy deny branch, driven for the first time, and two product defects

**`pnpm verify:tool-policy-deny` · 48/48, exit 0, stable over four consecutive runs (run11, run13–run15) · `pnpm check` exit 0**

## The gap, stated before the repair

The objective names ten vertical slices; the fifth is **"tool-policy allow/deny"**. The campaign's own
coverage map graded it **ALLOW ONLY**, and the grade rested on a count nobody had to run twice: every
fixture in the tree set `denied_tool_ids: []`, so `ToolDecision::Deny` had never been produced by a
real HTTP request. The branch existed (`routes/tools.rs:1758`), it had a production caller
(`routes/tools.rs:1687`), it was unit-tested 28 times — and it had never been *driven*.

This probe drives it. One policy (`default_posture: "allow"`, exactly one tool in `denied_tool_ids`),
two registered tools, one managed run, and the same endpoint produces opposite verdicts on the same
request shape. The allow leg is the positive control for the deny leg, not a separate check.

## Defect 1 (fail-open): a denial the product announces but does not record

**Pre-fix evidence** (`/tmp/v02-tool-policy-run9.log`):

```
X1: http=200 reason=none stored=completed
```

The device ASKS about the denied tool and is told NO (`decision: deny, reason: org_tool_denied`,
HTTP 200). It then POSTs a result for the same call — and the product records it: the ref row moves
to `completed`. The denial was advisory.

**Root cause.** `INSERT_TOOL_CALL_REF_SQL` hardcoded `'requested'` as the ref status:

```sql
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'requested', ?9, ?9)
```

`call_writes(input, status)` accepts the decided status and the UPDATE branch (repeat decisions)
uses it — but the INSERT branch (first decisions, i.e. nearly all of them) drops it on the floor.
So every first-time decision, allow or deny, left a ref stuck at `requested`. `record_tool_result`
refuses results only for refs that are terminal (`denied | failed | cancelled`), and a denied call
that still reads `requested` sails through the one gate that exists precisely to stop it. The
`persist_denial` comment even says "the call reference advances to `denied`" — the code did not do
what the comment promised, on the path that matters most.

**Repair.** The INSERT binds the decided status (`?9`, timestamps shift to `?10`); `NewToolCallRef`
gains a `status` field; `call_writes` passes it through. Three lines of product code plus a comment
explaining why the field must never be hardcoded again. `schema:bind-count` stays green (10 binds,
10 placeholders).

## Defect 2 (existence oracle): the check order reveals the run

**Pre-fix evidence** (same log):

```
foreign=403/device_not_approved phantom=404/resource_not_found
```

In `create_tool_decision` the device check ran *before* the organization check, so a device from
another organization was answered 403 while a run id existing nowhere was answered 404. 403-here
but 404-there confirms the run exists. The route already *had* the correct branch
(`scope.org_id != device.org_id → 404`); it was shadowed by ordering.

**Repair.** The organization check moves first. A same-organization device that is not the run's
device still gets 403 (same-tenant case, correctly unchanged); a foreign-organization device now
gets 404, byte-identical to the phantom. Post-fix: `foreign=404 phantom=404`.

## Post-fix evidence

| assertion | result |
|---|---|
| denied tool → stored `denied` with reason `org_tool_denied` | PASS, graded on the D1 row |
| non-denied tool → stored `allowed` on the same run and body (positive control) | PASS |
| `tool.decision_recorded.v1` envelope carries `deny` + `org_tool_denied` | PASS |
| no `approval_requests` row for the denied call | PASS |
| security row attributable per ADR 0007, actor is the device not `system` | PASS |
| run timeline shows `tool.denied.v1` with the reason (customer-visible surface) | PASS |
| X2 control: result for the ALLOWED call accepted, ref `completed` | PASS |
| X1: result for the DENIED call refused, ref stays `denied` | PASS |
| D6: lifting the deny re-allows the same tool on the same run | PASS |
| foreign-org 404 == phantom 404, and no decision row written | PASS |

48/48 on run11 (first green), run13 (post-sensitivity-restore), run14, run15. `pnpm check` exit 0.

## Sensitivity: both repairs watched to fail

- **M1** (`status,` → `status: "requested"` in `call_writes` — statement stays valid, bind count
  unchanged, only the claim breaks): exactly 4 legs red — stored-deny, stored-allow, X1
  (`http=200 stored=completed`, the pre-fix shape reproduced verbatim), D6-lifted. Everything else
  green. **DETECTED.**
- **M2** (check order reverted): exactly 1 leg red — the boundary comparison, back to
  `foreign=403 phantom=404`. Everything else green. **DETECTED.**
- Both restores verified byte-exact (`diff` clean), `cargo check` after each, HEAD unmoved throughout
  (no commit during mutation runs).

## Nine fixture faults, all mine, all recorded in the probe

The probe took 11 runs to go green; runs 1–10 failed on my fixture, never on the product (except X1,
which was the product). Each is recorded at the site with the validator cited, because the next
person to touch this fixture will otherwise pay the same runs: `visibility: "org"` not `"private"`
or `"restricted"` (restricted demands an explicit grant the fixture never creates —
`ensure_project_binding`); `source: "built_in"` not `"builtin"`; fingerprints are opaque
alphanumeric (no `:`); `tool_call_id` is `tcl_`+32hex; the phantom run id must be valid-format;
`arguments_summary` is `key=value` pairs; five missing `await`s `node --check` cannot see; the agent
must allow both tools; the run must be STARTed before deciding; the outbox type is
`tool.decision_recorded.v1` (`tool.denied.v1` is the timeline type); `/usage/denials` lists only
budget/rate-limit denials by design.

## What this does and does not establish

**Establishes:** slice 5 is now PROVEN — both halves driven over real HTTP, graded on stored rows,
with a working exploit leg (X1) proving the denial is now enforced rather than announced.

**Does not establish:** no sensitivity proof for the *attribution* or *timeline* legs (they have
never been watched to fail); the `record_tool_result` terminal gate on `failed`/`cancelled` refs is
exercised only via X2's `completed` path; a second decision for the same call (UPDATE branch) is not
driven.
