# F15 — Automations, Scheduled & Off-peak Tasks

Priority: P1  
Depends on: F07, F08, F12, F13, F19

## Objective

Đồng bộ và quản trị organization-aware automations dựa trên năng lực cron/off-peak scheduler đã có trong ZCode.

## Concepts

- AutomationDefinition
- ScheduleRule
- AutomationRun
- ExecutionTarget
- OffPeakPolicy

## Requirements

### FR-F15-001 — Automation ownership

Automation belongs to org + project, optionally bound to agent/session/workspace target.

### FR-F15-002 — Schedule

Support:

- one-time;
- cron;
- product-level interval rule that preserves semantics cron cannot faithfully represent;
- manual run.

Store canonical schedule semantics, not just display cron.

The server's once-per-minute sweep distinguishes the current tick from missed
history: a slot less than 60 seconds old is due, even with `missed_policy: skip`.
For that policy, retain at most the latest slot in this current tick and discard
older backlog; a slot exactly 60 seconds old is missed. This does not permit an
ambiguous or started occurrence to be reissued, and occurrence identity remains
the canonical scheduled instant rather than sweep time.

On create and update, the immutable schedule row's typed columns must be derived
from the same validated canonical revision used for scheduler evaluation and API
readback. Cron, one-time and interval definitions must satisfy the storage
constraints without dropping required fields or weakening those constraints.

### FR-F15-003 — Execution target

Automation specifies required environment:

- any eligible enrolled device;
- specific device;
- remote workspace;
- server-side runner if supported later.

### FR-F15-004 — Dispatch

Server decides due work and issues a lease/dispatch to eligible device.

Dispatch is performed by the `automation.dispatch` job for exactly one `pending` occurrence, from durable rows only (P06-CR-006): the stored job row names the tenant and subject, and the queue message is never an authority. The job re-reads the occurrence, the automation, the occurrence's own schedule revision and current eligibility, then moves the occurrence to `dispatching`, or records `missed`/`skipped` with a stable reason, in the same atomic batch as the job's claim and completion. An occurrence that is no longer `pending` (claimed, started, `ambiguous`, terminal) is never rewritten, and a job row that names no occurrence in its own organization is dead-lettered without writing or disclosing anything. A paused automation does not dispatch; its slot is recorded `skipped` and is not replayed on resume. Devices discover work only in `dispatching`.

On the dispatch edge the job also binds the org's latest published policy snapshot (id and version) to the occurrence in the same atomic batch (P06-CR-007), so `due`, `claim` and the P05 run carry the server-resolved policy the occurrence contract requires. A requeued occurrence re-binds the policy current at its new dispatch. If the org has published no snapshot there is nothing authoritative to bind, so the occurrence is recorded `skipped` with `policy_snapshot_unavailable` rather than dispatched with a null policy. A device never supplies or defaults this value.

The workspace a run executes in is likewise resolved by the server for the **claiming device** (P06-CR-008). A definition pinned to a binding keeps it, but only the device that owns that live binding may be offered, claim or start the occurrence. A binding-less target (`eligible_device`) resolves to the device's single live binding for the automation's project; a device with none, or with several, is not offered the work in `due`, is refused `claim` with `workspace_binding_unresolved` / `workspace_binding_ambiguous` before an attempt is spent, and `start` repeats the resolution and guards it in the same batch that creates the run. The P05 session and run therefore never carry a NULL binding for an automation run, and the resolved id is never taken from a request body. When an occurrence settles `failed` and its P05 run is still `queued` (never activated), the same settlement batch cancels that run (`failure_code = automation_run_not_started`, `run.cancelled.v1` event); a run that already advanced is not touched.

A device MUST atomically claim work to avoid duplicate side effects. A lease that expires after execution may have begun is marked `ambiguous` and cannot be automatically reissued; this distributed boundary is normative in `P06-CR-001`.

### FR-F15-005 — Idempotency

Each scheduled occurrence has stable `run_id`/occurrence key.

Retries do not create a second logical occurrence.

### FR-F15-006 — Policies

At execution time re-evaluate:

- membership/service identity;
- tool policy;
- model route;
- budget;
- device health/capability.

Do not use stale authorization captured when schedule was created.

### FR-F15-007 — Off-peak

Org may designate off-peak eligibility sources and windows, lower-cost route aliases, and mutation restrictions. P06 supports both an organization-window mode and the existing ZCode provider-ticket/no-clock mode; the eligibility source is explicit and the server never silently converts one into the other.

ZCode already separates off-peak tasks and applies special tool restrictions; preserve that safety distinction.

### FR-F15-008 — Missed schedules

Define per automation:

- skip;
- run once on recovery;
- catch up up to N.

Default should avoid burst replay after device reconnect.

### FR-F15-009 — Concurrency

Policy:

- allow overlap;
- skip if running;
- queue one;
- cancel previous.

## Web UX

- automations list;
- next run;
- last run;
- target device/workspace;
- schedule;
- budget/model policy;
- run history;
- pause/resume/run now.

## Acceptance criteria

- At most one current server-authorized lease exists for an occurrence. If a lease expires after execution may have started, the occurrence enters an audited `ambiguous` reconciliation state and is not automatically re-dispatched; a second device cannot claim it.
- Paused/suspended org stops new dispatch.
- Missed-run behavior is deterministic and visible.
